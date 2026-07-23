/**
 * Shared tools/call spine: gate, resolve, prepare payment/validation context, then dispatch.
 * Returns neutral outcomes; the shell constructs protocol errors and side-channel notifications.
 */

import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { InitializeRequest, Notification, Request } from '@modelcontextprotocol/sdk/types.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import dedent from 'dedent';

import log from '@apify/log';

import type { ApifyClient } from '../apify_client.js';
import { ALLOWED_TASK_TOOL_EXECUTION_MODES, FAILURE_CATEGORY, HELPER_TOOLS, TOOL_STATUS } from '../const.js';
import { prepareToolCallContext } from '../payments/helpers.js';
import type { PaymentMeta, RequestHeaders } from '../payments/types.js';
import { decodeDotPropertyNames } from '../tools/actor_input_schema.js';
import { legacyToolNameToNew } from '../tools/actor_tool_naming.js';
import { checkPaymentProviderStandbyConflict } from '../tools/actors/call_actor.js';
import { withReportProblemNudge } from '../tools/dev/report_problem.js';
import type { CallDiagnostics, ToolCallTelemetryProperties, ToolEntry, ToolStatus } from '../types.js';
import { TOOL_TYPE } from '../types.js';
import { logHttpError } from '../utils/logging.js';
import { respondOk } from '../utils/mcp.js';
import { getRequestOriginForClient } from '../utils/mcp_clients.js';
import type { buildPaymentRequiredResponse } from '../utils/payment_errors.js';
import { createProgressTracker } from '../utils/progress.js';
import { extractAjvErrorDetails } from '../utils/tool_status.js';
import { buildActorFields, extractActorId, extractActorName, getToolFullName } from '../utils/tools.js';
import type { ActorsMcpServer } from './server.js';
import { buildToolCallErrorResult, TOOL_CALL_ERROR_KIND } from './tool_call_error_mapper.js';
import type { ToolCallErrorResult } from './tool_call_error_mapper.js';
import { dispatchToolCall } from './tool_dispatch.js';

/** A pre-dispatch failure that the shell converts to v1's protocol-error sequence. */
export type InvalidToolCall = {
    message: string;
    toolStatus: ToolStatus;
    callDiagnostics: CallDiagnostics;
    logFields?: Record<string, unknown>;
    // Set after resolution so the shell preserves v1 telemetry on validation failures.
    resolvedToolName?: string;
    // Set after decoding so the shell preserves v1's decoded-argument telemetry.
    decodedArgs?: Record<string, unknown>;
};

/** Successful preparation output for the task and synchronous paths. */
export type PreparedCall = {
    tool: ToolEntry;
    toolArgs: Record<string, unknown>;
    logSafeArgs: unknown;
    apifyClient: ApifyClient;
    actorName: string | undefined;
    actorId: string | undefined;
    standbyRejection: Record<string, unknown> | null;
    paymentRequiredResult: ReturnType<typeof buildPaymentRequiredResponse> | undefined;
    // The shell uses this decoded copy for telemetry.
    decodedArgs: Record<string, unknown>;
};

/** Result of the synchronous dispatch tail, including the exact wire payload. */
export type ToolCallOutcome = {
    result: Record<string, unknown>;
    toolStatus: ToolStatus;
    callDiagnostics: CallDiagnostics;
};

/** Classified non-protocol failure after resolution, retaining v1 actor telemetry context. */
export type PreparedCallError = ToolCallOutcome & {
    resolvedToolName: string;
    decodedArgs: Record<string, unknown>;
};

/** Builds the pre-flight result; standby rejection takes precedence over 402. */
export function buildPreflightFailureOutcome(
    standbyRejection: Record<string, unknown> | null,
    paymentRequiredResult: ReturnType<typeof buildPaymentRequiredResponse> | undefined,
    actorName: string | undefined,
    actorId: string | undefined,
): {
    toolStatus: ToolStatus;
    callDiagnostics: CallDiagnostics;
    result: Record<string, unknown> | ReturnType<typeof buildPaymentRequiredResponse>;
} {
    return {
        toolStatus: TOOL_STATUS.SOFT_FAIL,
        callDiagnostics: {
            failure_category: FAILURE_CATEGORY.INVALID_INPUT,
            ...(standbyRejection ? {} : { failure_http_status: 402 }),
            ...buildActorFields(actorName, actorId),
        },
        result: (standbyRejection ?? paymentRequiredResult)!,
    };
}

/** Prepares a call; protocol errors are left to the shell. */
export async function prepareToolCall(params: {
    apifyMcpServer: ActorsMcpServer;
    apifyToken: string;
    name: string;
    args: Record<string, unknown> | undefined;
    meta: PaymentMeta;
    requestHeaders: RequestHeaders;
    isTaskRequest: boolean;
    mcpSessionId: string | undefined;
    telemetryData: ToolCallTelemetryProperties | null;
    extra?: RequestHandlerExtra<Request, Notification>;
    initializeRequestData?: InitializeRequest;
    tools?: Map<string, ToolEntry>;
}): Promise<PreparedCall | InvalidToolCall | PreparedCallError> {
    const { apifyMcpServer, apifyToken, name, meta, requestHeaders, isTaskRequest, telemetryData } = params;
    let { args } = params;
    const { options } = apifyMcpServer;
    const tools = params.tools ?? apifyMcpServer.tools;
    const initializeRequestData = Object.hasOwn(params, 'initializeRequestData')
        ? params.initializeRequestData
        : options.initializeRequestData;

    if (!apifyToken && !options.paymentProvider?.allowsUnauthenticated && !options.allowUnauthMode) {
        return {
            message: dedent`
                Apify API token is required but was not provided.
                Please set the APIFY_TOKEN environment variable or pass it as a parameter in the request header as Authorization Bearer <token>.
                You can get your Apify token from https://console.apify.com/account/integrations.
            `,
            toolStatus: TOOL_STATUS.SOFT_FAIL,
            callDiagnostics: { failure_category: FAILURE_CATEGORY.AUTH },
        };
    }

    const newName = legacyToolNameToNew(name) ?? name;
    const toolEntry = Array.from(tools.values()).find((t) => t.name === newName || getToolFullName(t) === newName);

    if (!toolEntry) {
        const availableTools = Array.from(tools.keys());
        return {
            message: dedent`
                Tool "${name}" was not found.
                Available tools: ${availableTools.length > 0 ? availableTools.join(', ') : 'none'}.
                Please verify the tool name is correct. You can list all available tools using the tools/list request.
            `,
            toolStatus: TOOL_STATUS.SOFT_FAIL,
            callDiagnostics: { failure_category: FAILURE_CATEGORY.INVALID_INPUT },
        };
    }

    const tool = toolEntry;
    const resolvedToolName = getToolFullName(tool);
    if (telemetryData) {
        telemetryData.tool_name = resolvedToolName;
    }

    const actorName = extractActorName(tool, args as Record<string, unknown>);
    const actorId = extractActorId(tool);

    if (!args) {
        return {
            message: dedent`
                Missing arguments for tool "${name}".
                Please provide the required arguments for this tool. Check the tool's input schema using ${HELPER_TOOLS.ACTOR_GET_DETAILS} tool to see what parameters are required.
            `,
            toolStatus: TOOL_STATUS.SOFT_FAIL,
            callDiagnostics: {
                failure_category: FAILURE_CATEGORY.INVALID_INPUT,
                ...buildActorFields(actorName, actorId),
            },
            resolvedToolName,
        };
    }

    // Preserve the raw value if decoding throws before reassignment.
    let decodedArgs = args as Record<string, unknown>;

    // v1 captured actor context before these operations; retain it when classifying their failures.
    try {
        // Validation expects decoded property names.
        args = decodeDotPropertyNames(args as Record<string, unknown>) as Record<string, unknown>;
        decodedArgs = args as Record<string, unknown>;

        const {
            toolArgsWithoutPayment: toolArgs,
            toolArgsRedacted: logSafeArgs,
            apifyClient,
            paymentRequiredResult,
        } = prepareToolCallContext({
            provider: options.paymentProvider,
            tool,
            args: args as Record<string, unknown>,
            apifyToken,
            meta,
            requestHeaders,
            requestOrigin: getRequestOriginForClient(initializeRequestData),
        });

        log.debug('Validate arguments for tool', {
            toolName: tool.name,
            mcpSessionId: params.mcpSessionId,
            input: logSafeArgs,
        });
        if (!tool.ajvValidate(toolArgs)) {
            const errors = tool.ajvValidate.errors || [];
            const ajvErrorDetails = extractAjvErrorDetails(errors);
            const errorMessages = errors
                .map(
                    (e: { message?: string; instancePath?: string }) =>
                        `${e.instancePath || 'root'}: ${e.message || 'validation error'}`,
                )
                .join('; ');
            return {
                message: dedent`
                    Invalid arguments for tool "${tool.name}".
                    Validation errors: ${errorMessages}.
                    Please check the tool's input schema using ${HELPER_TOOLS.ACTOR_GET_DETAILS} tool and ensure all required parameters are provided with correct types and values.
                `,
                toolStatus: TOOL_STATUS.SOFT_FAIL,
                callDiagnostics: {
                    failure_category: FAILURE_CATEGORY.INVALID_INPUT,
                    ...ajvErrorDetails,
                    ...buildActorFields(actorName, actorId),
                },
                resolvedToolName,
                decodedArgs,
            };
        }

        const taskSupport = tool.execution?.taskSupport as (typeof ALLOWED_TASK_TOOL_EXECUTION_MODES)[number];
        if (isTaskRequest && !ALLOWED_TASK_TOOL_EXECUTION_MODES.includes(taskSupport)) {
            return {
                message: dedent`
                    Tool "${tool.name}" does not support long running task calls.
                    Please remove the "task" parameter from the tool call request or use a different tool that supports long running tasks.
                `,
                toolStatus: TOOL_STATUS.SOFT_FAIL,
                callDiagnostics: {
                    failure_category: FAILURE_CATEGORY.INVALID_INPUT,
                    ...buildActorFields(actorName, actorId),
                },
                resolvedToolName,
                decodedArgs,
            };
        }

        // Standby Actors need a specific rejection instead of a generic 402 in both modes.
        const { paymentProvider } = options;
        const isCallActorTool = tool.name === HELPER_TOOLS.ACTOR_CALL || tool.name === HELPER_TOOLS.ACTOR_CALL_WIDGET;
        const actorArg = (toolArgs as { actor?: unknown } | undefined)?.actor;

        const standbyRejection =
            paymentProvider && isCallActorTool && typeof actorArg === 'string' && actorArg.length > 0
                ? await checkPaymentProviderStandbyConflict({
                      actorName: actorArg,
                      paymentProvider,
                      apifyToken,
                      mcpSessionId: params.mcpSessionId,
                  })
                : null;

        return {
            tool,
            toolArgs,
            logSafeArgs,
            apifyClient,
            actorName,
            actorId,
            standbyRejection,
            paymentRequiredResult,
            decodedArgs,
        };
    } catch (error) {
        // Keep protocol errors as JSON-RPC errors; classify other failures with actor context.
        if (error instanceof McpError) throw error;
        const outcome = classifyToolCallError(error, {
            apifyMcpServer,
            toolName: name,
            failingToolName: resolvedToolName,
            actorName,
            actorId,
            isAborted: Boolean(params.extra?.signal?.aborted),
            mcpSessionId: params.mcpSessionId,
            tools,
        });
        return { ...outcome, resolvedToolName, decodedArgs };
    }
}

/** Runs pre-flight handling and dispatch, returning the exact wire payload. */
export async function executeSyncToolCall(
    prepared: PreparedCall,
    params: {
        apifyMcpServer: ActorsMcpServer;
        apifyToken: string;
        toolName: string;
        mcpSessionId: string | undefined;
        progressToken: string | number | undefined;
        extra: RequestHandlerExtra<Request, Notification>;
        tools?: Map<string, ToolEntry>;
    },
): Promise<ToolCallOutcome> {
    const { apifyMcpServer, apifyToken, toolName, mcpSessionId, progressToken, extra } = params;
    const { tool, toolArgs, logSafeArgs, apifyClient, actorName, actorId, standbyRejection, paymentRequiredResult } =
        prepared;
    const resolvedToolName = getToolFullName(tool);

    const nudge = (result: unknown, callDiagnostics: CallDiagnostics): Record<string, unknown> =>
        withReportProblemNudge({
            result,
            tools: params.tools ?? apifyMcpServer.tools,
            failingToolName: resolvedToolName,
            failureCategory: callDiagnostics.failure_category,
            failureHttpStatus: callDiagnostics.failure_http_status,
        }) as Record<string, unknown>;

    if (standbyRejection || paymentRequiredResult) {
        const outcome = buildPreflightFailureOutcome(standbyRejection, paymentRequiredResult, actorName, actorId);
        return {
            result: nudge(outcome.result, outcome.callDiagnostics),
            toolStatus: outcome.toolStatus,
            callDiagnostics: outcome.callDiagnostics,
        };
    }

    // Progress tracker: opt in for the two INTERNAL tools that emit during a sync wait
    // (call-actor start+waitForFinish, get-actor-run when waitSecs > 0), and unconditionally
    // for ACTOR tools. ACTOR_MCP forwards notifications directly, not via a tracker.
    const progressTrackerOptIn =
        tool.type === TOOL_TYPE.ACTOR ||
        (tool.type === TOOL_TYPE.INTERNAL &&
            (tool.name === HELPER_TOOLS.ACTOR_CALL || tool.name === HELPER_TOOLS.ACTOR_RUNS_GET));
    const progressTracker = progressTrackerOptIn ? createProgressTracker(progressToken, extra.sendNotification) : null;

    try {
        const dispatchResult = await dispatchToolCall({
            tool,
            toolArgs,
            logSafeArgs,
            apifyToken,
            apifyClient,
            apifyMcpServer,
            mcpSessionId,
            progressToken,
            progressTracker,
            shouldForwardNotifications: true,
            extra,
            actorName,
            actorId,
            taskMode: false,
        });
        return {
            result: nudge(dispatchResult.result, dispatchResult.callDiagnostics),
            toolStatus: dispatchResult.toolStatus,
            callDiagnostics: dispatchResult.callDiagnostics,
        };
    } catch (error) {
        // Protocol errors stay JSON-RPC errors; a 402-coded McpError must not become a payment result.
        if (error instanceof McpError) throw error;
        return classifyToolCallError(error, {
            apifyMcpServer,
            toolName,
            failingToolName: resolvedToolName,
            actorName,
            actorId,
            isAborted: Boolean(extra.signal?.aborted),
            mcpSessionId,
            tools: params.tools,
        });
    }
}

/** Maps non-protocol errors to v1 tool results, including diagnostics and report-problem nudges. */
export function classifyToolCallError(
    error: unknown,
    params: {
        apifyMcpServer: ActorsMcpServer;
        toolName: string;
        failingToolName: string;
        actorName: string | undefined;
        actorId: string | undefined;
        isAborted: boolean;
        mcpSessionId: string | undefined;
        tools?: Map<string, ToolEntry>;
    },
): ToolCallOutcome {
    const { apifyMcpServer, toolName, failingToolName, actorName, actorId, isAborted, mcpSessionId } = params;

    const nudge = (result: unknown, callDiagnostics: CallDiagnostics): Record<string, unknown> =>
        withReportProblemNudge({
            result,
            tools: params.tools ?? apifyMcpServer.tools,
            failingToolName,
            failureCategory: callDiagnostics.failure_category,
            failureHttpStatus: callDiagnostics.failure_http_status,
        }) as Record<string, unknown>;

    const errorResult = buildToolCallErrorResult(error, { toolName, actorName, actorId, isAborted });
    const { toolStatus } = errorResult;

    switch (errorResult.kind) {
        case TOOL_CALL_ERROR_KIND.PAYMENT: {
            const { callDiagnostics } = errorResult;
            return { result: nudge(errorResult.response, callDiagnostics), toolStatus, callDiagnostics };
        }
        case TOOL_CALL_ERROR_KIND.APPROVAL: {
            const { callDiagnostics } = errorResult;
            logHttpError(error, 'Permission approval required while calling tool', { toolName, mcpSessionId });
            return { result: nudge(errorResult.response, callDiagnostics), toolStatus, callDiagnostics };
        }
        case TOOL_CALL_ERROR_KIND.EXECUTION: {
            const callDiagnostics: CallDiagnostics = {
                ...buildActorFields(actorName, actorId),
                ...errorResult.callDiagnostics,
            };

            logHttpError(error, 'Error occurred while calling tool', {
                toolName,
                toolStatus,
                mcpSessionId,
                failureCategory: callDiagnostics.failure_category,
                failureHttpStatus: callDiagnostics.failure_http_status,
                actorName: callDiagnostics.actor_name,
                validationKeyword: callDiagnostics.validation_keyword,
                validationPath: callDiagnostics.validation_path,
                validationMissingProperty: callDiagnostics.validation_missing_property,
                validationAdditionalProperty: callDiagnostics.validation_additional_property,
            });
            return {
                result: nudge(
                    { ...respondOk(errorResult.userText), isError: true, toolTelemetry: { toolStatus } },
                    callDiagnostics,
                ),
                toolStatus,
                callDiagnostics,
            };
        }
        default:
            throw new Error(
                `Unknown tool-call error kind "${(errorResult satisfies never as ToolCallErrorResult).kind}"`,
            );
    }
}
