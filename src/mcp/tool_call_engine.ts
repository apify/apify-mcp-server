/**
 * Shared tools/call spine: gate, resolve, prepare payment/validation context, then dispatch.
 * Returns neutral outcomes; the shell constructs protocol errors and side-channel notifications.
 */

import type { ServerNotification } from '@modelcontextprotocol/sdk/types.js';
import type { ErrorObject } from 'ajv';
import dedent from 'dedent';

import log from '@apify/log';

import type { ApifyClient } from '../apify_client.js';
import { ALLOWED_TASK_TOOL_EXECUTION_MODES, FAILURE_CATEGORY, HELPER_TOOLS, TOOL_STATUS } from '../const.js';
import { prepareToolCallContext } from '../payments/helpers.js';
import type { PaymentMeta, PaymentProvider, RequestHeaders } from '../payments/types.js';
import { decodeDotPropertyNames } from '../tools/actor_input_schema.js';
import { legacyToolNameToNew } from '../tools/actor_tool_naming.js';
import {
    buildDeniedInputsNote,
    getDeniedDirectActorInputs,
    getDirectActorPolicy,
} from '../tools/actors/actor_tool_contract.js';
import { buildLegacyMcpSyntaxRejection, checkPaymentProviderStandbyConflict } from '../tools/actors/call_actor.js';
import { withReportProblemNudge } from '../tools/dev/report_problem.js';
import type {
    ActorStore,
    CallDiagnostics,
    ToolCallTelemetryProperties,
    ToolEntry,
    ToolStatus,
    ToolTelemetryContext,
} from '../types.js';
import { TOOL_TYPE } from '../types.js';
import { logHttpError } from '../utils/logging.js';
import { respondOk } from '../utils/mcp.js';
import { getRequestOriginForClient, resolveStoreSearchTracking } from '../utils/mcp_clients.js';
import type { buildPaymentRequiredResponse } from '../utils/payment_errors.js';
import { createProgressTracker } from '../utils/progress.js';
import { extractAjvErrorDetails, isMcpError } from '../utils/tool_status.js';
import { buildActorFields, extractActorId, extractActorName, getToolFullName } from '../utils/tools.js';
import type { McpClientContext } from './client_context.js';
import { buildToolCallErrorResult, TOOL_CALL_ERROR_KIND } from './tool_call_error_mapper.js';
import type { ToolCallErrorResult } from './tool_call_error_mapper.js';
import { dispatchToolCall } from './tool_dispatch.js';

/** INTERNAL tools that wait synchronously and emit progress meanwhile: call-actor's start and wait, get-actor-run, get-actor-build and build-actor with waitSecs > 0. */
const PROGRESS_TRACKER_INTERNAL_TOOLS = new Set<string>([
    HELPER_TOOLS.ACTOR_CALL,
    HELPER_TOOLS.ACTOR_RUNS_GET,
    HELPER_TOOLS.ACTOR_BUILD_GET,
    HELPER_TOOLS.ACTOR_BUILD,
]);

/** The value or subschema at JSON pointer `path`: `undefined` when it does not exist. */
function resolveJsonPointer(root: unknown, path: string, isSchema: boolean): unknown {
    const segments = path
        .split('/')
        .slice(1)
        .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
    return segments.reduce<unknown>((node, segment) => {
        if (typeof node !== 'object' || node === null) return undefined;
        if (!isSchema) return (node as Record<string, unknown>)[segment];
        const { properties, items } = node as { properties?: Record<string, unknown>; items?: unknown };
        return properties?.[segment] ?? items;
    }, root);
}

/** The JSON type of `value`, named as AJV names types. */
function getJsonTypeName(value: unknown): string {
    if (value === null) return 'null';
    return Array.isArray(value) ? 'array' : typeof value;
}

/**
 * The validation failure text: each error with the type received for a type error, then the description of each
 * failing parameter, so the caller learns what the parameter takes without another lookup.
 */
function buildAjvFailureText(errors: ErrorObject[], args: unknown, inputSchema: unknown): string {
    const parameterPaths = new Set<string>();
    const failures = errors.map((error) => {
        const { missingProperty } = error.params as { missingProperty?: string };
        parameterPaths.add(missingProperty ? `${error.instancePath}/${missingProperty}` : error.instancePath);
        const received =
            error.keyword === 'type'
                ? `, got ${getJsonTypeName(resolveJsonPointer(args, error.instancePath, false))}`
                : '';
        const allowedValues = error.keyword === 'enum' ? `: ${JSON.stringify(error.params.allowedValues)}` : '';
        return `${error.instancePath || 'root'}: ${error.message || 'validation error'}${received}${allowedValues}`;
    });
    const descriptions = new Set<string>();
    for (let path of parameterPaths) {
        // Dictionary values may have no description; their parent explains the accepted shape.
        while (path) {
            const { description } = (resolveJsonPointer(inputSchema, path, true) ?? {}) as { description?: unknown };
            if (typeof description === 'string') {
                descriptions.add(`Parameter ${path}: ${description}`);
                break;
            }
            path = path.slice(0, path.lastIndexOf('/'));
        }
    }
    return [`Validation errors: ${failures.join('; ')}.`, ...descriptions].join('\n');
}

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

/**
 * Builds the pre-flight result; standby rejection takes precedence over 402. The rejection skipped dispatch, which
 * strips `toolTelemetry` from a tool response, so it is stripped here and its failure detail recorded.
 */
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
    const { toolTelemetry, ...rejection } = (standbyRejection ?? {}) as { toolTelemetry?: ToolTelemetryContext };
    return {
        toolStatus: TOOL_STATUS.SOFT_FAIL,
        callDiagnostics: {
            failure_category: FAILURE_CATEGORY.INVALID_INPUT,
            ...(standbyRejection ? {} : { failure_http_status: 402 }),
            ...(toolTelemetry?.failureDetail && { failure_detail: toolTelemetry.failureDetail }),
            ...buildActorFields(actorName, actorId),
        },
        result: standbyRejection ? rejection : paymentRequiredResult!,
    };
}

/**
 * The tool a `tools/call` names, accepting a legacy alias or an Actor's full name. The single
 * resolution rule: a shell that needs the tool before {@link prepareToolCall} returns (e.g. for its
 * `outputSchema`) must resolve it the same way, or the two can disagree about which tool was called.
 */
export function resolveToolEntry(name: string, tools: Map<string, ToolEntry>): ToolEntry | undefined {
    const newName = legacyToolNameToNew(name) ?? name;
    return Array.from(tools.values()).find((tool) => tool.name === newName || getToolFullName(tool) === newName);
}

/** Prepares a call; protocol errors are left to the shell. */
export async function prepareToolCall(params: {
    apifyToken: string;
    name: string;
    args: Record<string, unknown> | undefined;
    meta: PaymentMeta;
    requestHeaders: RequestHeaders;
    isTaskRequest: boolean;
    mcpSessionId: string | undefined;
    telemetryData: ToolCallTelemetryProperties | null;
    clientContext: McpClientContext | undefined;
    tools: Map<string, ToolEntry>;
    paymentProvider?: PaymentProvider;
    allowUnauthMode?: boolean;
    // Used to preserve abort status for a post-resolution classified failure.
    signal?: AbortSignal;
}): Promise<PreparedCall | InvalidToolCall | PreparedCallError> {
    const {
        apifyToken,
        name,
        meta,
        requestHeaders,
        isTaskRequest,
        telemetryData,
        clientContext,
        tools,
        paymentProvider,
        allowUnauthMode,
    } = params;
    let { args } = params;
    const requestOrigin = getRequestOriginForClient(clientContext);
    const storeSearchTracking = telemetryData
        ? resolveStoreSearchTracking(requestOrigin, meta, params.mcpSessionId)
        : undefined;
    if (telemetryData && storeSearchTracking?.traceId) {
        telemetryData.trace_id = storeSearchTracking.traceId;
    }

    if (!apifyToken && !paymentProvider?.allowsUnauthenticated && !allowUnauthMode) {
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

    const toolEntry = resolveToolEntry(name, tools);

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
    // Actor details describe the original schema; restricted direct tools publish their own in tools/list.
    const schemaHint =
        tool.type === TOOL_TYPE.ACTOR &&
        !getDirectActorPolicy(tool.actorFullName) &&
        tools.has(HELPER_TOOLS.ACTOR_GET_DETAILS)
            ? `using ${HELPER_TOOLS.ACTOR_GET_DETAILS} tool`
            : 'in tools/list';

    if (!args) {
        return {
            message: dedent`
                Missing arguments for tool "${name}".
                Please provide the required arguments for this tool. Check the tool's input schema ${schemaHint} to see what parameters are required.
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
            provider: paymentProvider,
            tool,
            args: args as Record<string, unknown>,
            apifyToken,
            meta,
            requestHeaders,
            requestOrigin,
        });
        apifyClient.storeSearchTracking = storeSearchTracking;

        log.debug('Validate arguments for tool', {
            toolName: tool.name,
            mcpSessionId: params.mcpSessionId,
            input: logSafeArgs,
        });
        const deniedInputs =
            tool.type === TOOL_TYPE.ACTOR ? getDeniedDirectActorInputs(tool.actorFullName, toolArgs) : [];
        if (tool.type === TOOL_TYPE.ACTOR && deniedInputs.length) {
            return {
                message: `Invalid arguments for tool "${tool.name}": ${buildDeniedInputsNote(tool.actorFullName, deniedInputs)}`,
                toolStatus: TOOL_STATUS.SOFT_FAIL,
                callDiagnostics: {
                    failure_category: FAILURE_CATEGORY.INVALID_INPUT,
                    ...buildActorFields(actorName, actorId),
                },
                resolvedToolName,
                decodedArgs,
            };
        }
        if (!tool.ajvValidate(toolArgs)) {
            const errors = tool.ajvValidate.errors || [];
            const ajvErrorDetails = extractAjvErrorDetails(errors);
            return {
                message: [
                    `Invalid arguments for tool "${tool.name}".`,
                    buildAjvFailureText(errors, toolArgs, tool.inputSchema),
                    // Only an Actor tool's schema is worth a pointer: it is the Actor's input schema. Another
                    // tool's schema is already in the client's tools/list.
                    ...(tool.type === TOOL_TYPE.ACTOR
                        ? [
                              `Please check the tool's input schema ${schemaHint} and ensure all required parameters are provided with correct types and values.`,
                          ]
                        : []),
                ].join('\n'),
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

        const standbyRejection =
            buildLegacyMcpSyntaxRejection(tool.name, toolArgs.actor, Array.from(tools.keys())) ??
            (await checkPaymentProviderStandbyConflict({
                tool,
                args: toolArgs,
                paymentProvider,
                apifyToken,
                mcpSessionId: params.mcpSessionId,
            }));

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
        if (isMcpError(error)) throw error;
        const outcome = classifyToolCallError(error, {
            tools,
            toolName: name,
            failingToolName: resolvedToolName,
            actorName,
            actorId,
            isAborted: Boolean(params.signal?.aborted),
            mcpSessionId: params.mcpSessionId,
        });
        return { ...outcome, resolvedToolName, decodedArgs };
    }
}

/** Runs pre-flight handling and dispatch, returning the exact wire payload. */
export async function executeSyncToolCall(
    prepared: PreparedCall,
    params: {
        apifyToken: string;
        toolName: string;
        mcpSessionId: string | undefined;
        progressToken: string | number | undefined;
        tools: Map<string, ToolEntry>;
        actorStore?: ActorStore;
        paymentProvider?: PaymentProvider;
        signal: AbortSignal;
        sendNotification: (notification: ServerNotification) => Promise<void>;
        emitLog: (msg: { level: string; data?: unknown }) => Promise<void>;
    },
): Promise<ToolCallOutcome> {
    const {
        apifyToken,
        toolName,
        mcpSessionId,
        progressToken,
        tools,
        actorStore,
        paymentProvider,
        signal,
        sendNotification,
        emitLog,
    } = params;
    const { tool, toolArgs, logSafeArgs, apifyClient, actorName, actorId, standbyRejection, paymentRequiredResult } =
        prepared;
    const resolvedToolName = getToolFullName(tool);

    const nudge = (result: unknown, callDiagnostics: CallDiagnostics): Record<string, unknown> =>
        withReportProblemNudge({
            result,
            tools,
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

    // Progress tracker: opt in for the INTERNAL tools that emit during a sync wait, and
    // unconditionally for ACTOR tools. ACTOR_MCP forwards notifications directly, not via a tracker.
    const progressTrackerOptIn =
        tool.type === TOOL_TYPE.ACTOR ||
        (tool.type === TOOL_TYPE.INTERNAL && PROGRESS_TRACKER_INTERNAL_TOOLS.has(tool.name));
    const progressTracker = progressTrackerOptIn ? createProgressTracker(progressToken, sendNotification) : null;

    try {
        const dispatchResult = await dispatchToolCall({
            tool,
            toolArgs,
            logSafeArgs,
            apifyToken,
            apifyClient,
            mcpSessionId,
            progressToken,
            progressTracker,
            shouldForwardNotifications: true,
            signal,
            sendNotification,
            emitLog,
            actorStore,
            paymentProvider,
            tools,
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
        if (isMcpError(error)) throw error;
        return classifyToolCallError(error, {
            tools,
            toolName,
            failingToolName: resolvedToolName,
            actorName,
            actorId,
            isAborted: Boolean(signal.aborted),
            mcpSessionId,
        });
    }
}

/** Maps non-protocol errors to v1 tool results, including diagnostics and report-problem nudges. */
export function classifyToolCallError(
    error: unknown,
    params: {
        tools: Map<string, ToolEntry>;
        toolName: string;
        failingToolName: string;
        actorName: string | undefined;
        actorId: string | undefined;
        isAborted: boolean;
        mcpSessionId: string | undefined;
    },
): ToolCallOutcome {
    const { tools, toolName, failingToolName, actorName, actorId, isAborted, mcpSessionId } = params;

    const nudge = (result: unknown, callDiagnostics: CallDiagnostics): Record<string, unknown> =>
        withReportProblemNudge({
            result,
            tools,
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
