/**
 * Shared tool-call orchestration engine. Plain functions taking the `ActorsMcpServer` instance
 * (as `apifyMcpServer`), mirroring `tool_dispatch.ts` conventions; owns no class state. Both eras of
 * the MCP surface call this to run the same `tools/call` spine: token gate → tool resolution →
 * args/AJV validation → payment context → task-support check → standby/402 pre-flight → dispatch →
 * error classification → report-problem nudge.
 *
 * The engine imports no SDK error type (`McpError` / `ProtocolError`): failures are returned as
 * neutral `InvalidToolCall` / `ToolCallOutcome` values and each shell constructs its own protocol
 * error and side-channel emission. See `src/mcp/AGENTS.md`.
 */

import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { Notification, Request } from '@modelcontextprotocol/sdk/types.js';
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

/**
 * A prep failure known before any Actor runs. The shell reproduces v1's exact tail from this:
 * assign `toolStatus`/`callDiagnostics`, `log.softFail(message, …)`, emit the logging side-channel,
 * then throw its own protocol error. `logFields` mirrors the (currently unused) third arg of the v1
 * `failInvalidParams` helper.
 */
export type InvalidToolCall = {
    message: string;
    toolStatus: ToolStatus;
    callDiagnostics: CallDiagnostics;
    logFields?: Record<string, unknown>;
    // Resolved full tool name (getToolFullName), set once the tool is resolved so the shell logs it
    // unconditionally — matching v1, which set resolvedToolName right after resolution regardless of
    // telemetry. Absent on the pre-resolution rejects (missing token, tool not found).
    resolvedToolName?: string;
    // Dot-decoded args, set once decoding has run so the shell's telemetry sees decoded keys — matching
    // v1, which reassigned the closure `args` before the `finally`. Absent on rejects before the decode.
    decodedArgs?: Record<string, unknown>;
};

/** Successful prep outputs consumed by the v1 task branch and by `executeSyncToolCall`. */
export type PreparedCall = {
    tool: ToolEntry;
    toolArgs: Record<string, unknown>;
    logSafeArgs: unknown;
    apifyClient: ApifyClient;
    actorName: string | undefined;
    actorId: string | undefined;
    standbyRejection: Record<string, unknown> | null;
    paymentRequiredResult: ReturnType<typeof buildPaymentRequiredResponse> | undefined;
    // Dot-decoded args, so the shell can feed telemetry the decoded copy (matching v1's closure reassign).
    decodedArgs: Record<string, unknown>;
};

/**
 * Neutral result of the synchronous dispatch tail. The shell projects this to v1 by identity:
 * return `result` (already the exact wire payload, nudge applied), copy `toolStatus`/`callDiagnostics`.
 * The success, pre-flight short-circuit, and classified tool-error paths all produce this shape.
 */
export type ToolCallOutcome = {
    result: Record<string, unknown>;
    toolStatus: ToolStatus;
    callDiagnostics: CallDiagnostics;
};

/**
 * A `ToolCallOutcome` for a non-`McpError` throw that originates INSIDE the prep spine AFTER tool
 * resolution (e.g. `checkPaymentProviderStandbyConflict → getActorDefinition` re-throwing a 5xx, or a
 * throw in `prepareToolCallContext`). Base v1 assigned `actorName`/`actorId` right after resolution, so
 * such a throw reached its outer catch with the actor context set — telemetry + `logHttpError` carried
 * `actor_name`/`actor_id`. The prep spine now classifies these itself (reusing `classifyToolCallError`)
 * so the actor context is not lost, and the shell interprets the result like any other outcome.
 * Carries `resolvedToolName`/`decodedArgs` so the shell's telemetry `finally` logs the resolved name and
 * decoded args, exactly as base did (both set before the throw could occur).
 */
export type PreparedCallError = ToolCallOutcome & {
    resolvedToolName: string;
    decodedArgs: Record<string, unknown>;
};

/**
 * Shared diagnostics for a pre-flight failure (standby-provider conflict or missing/invalid payment
 * signature) — a call outcome already known before any Actor runs. Standby rejection wins over the
 * generic payment-required failure so the agent gets the precise reason instead of a generic 402.
 * Pure: callers own their own post-handling (return the result directly, or store + notify + synthesize
 * a terminal task) — call this only once `standbyRejection ?? paymentRequiredResult` is already truthy.
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

/**
 * The prep spine. Runs token gate → tool resolution → args-present → decode → payment context → AJV
 * validate → task-support check → standby/402 pre-flight compute. Returns a `PreparedCall` on success,
 * an `InvalidToolCall` on any pre-flight rejection, or a `PreparedCallError` when a step AFTER tool
 * resolution throws a non-`McpError` (classified here with the in-scope actor context). Never throws a
 * protocol error. Mutates `telemetryData.tool_name` at resolution (like the v1 handler) so telemetry
 * carries the resolved name.
 */
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
    // Request-scoped extra, read only to derive `isAborted` when classifying a post-resolution throw
    // (mirrors base's outer-catch `Boolean(extra.signal?.aborted)`). Optional so direct engine callers
    // that never trigger such a throw need not supply it.
    extra?: RequestHandlerExtra<Request, Notification>;
}): Promise<PreparedCall | InvalidToolCall | PreparedCallError> {
    const { apifyMcpServer, apifyToken, name, meta, requestHeaders, isTaskRequest, telemetryData } = params;
    let { args } = params;
    const { options, tools } = apifyMcpServer;

    // Validate token
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

    // Find tool by name, actor full name, or legacy tool name (e.g. apify-slash-rag-web-browser → apify--rag-web-browser)
    const newName = legacyToolNameToNew(name) ?? name;
    const toolEntry = Array.from(tools.values()).find((t) => t.name === newName || getToolFullName(t) === newName);

    if (!toolEntry) {
        const availableTools = apifyMcpServer.listToolNames();
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
    // Update telemetry tool name now that we resolved the tool (uses actorFullName for actor tools).
    if (telemetryData) {
        telemetryData.tool_name = resolvedToolName;
    }

    // Extract actor name/id for telemetry — available even when validation fails later.
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

    // Decoded args as the shell's telemetry copy. Seeded with the raw args so that if the decode below
    // throws (near-impossible for pure key-remapping) the shell keeps the raw args, matching base (which
    // reassigned its `args` closure only on a successful decode). Reassigned to the decoded value below.
    let decodedArgs = args as Record<string, unknown>;

    // Everything from here runs AFTER tool resolution — actorName/actorId are known. Base assigned them
    // right after resolution, so a non-McpError throw from these steps (payment context, standby check)
    // reached its outer catch with the actor context set. Classify such a throw here, with the same
    // context, so telemetry + logHttpError carry actor_name/actor_id byte-identically. No McpError
    // originates in this region (the same reasoning that lets executeSyncToolCall's catch classify
    // without an McpError guard: remote-McpError routes are sealed by inner catches, and these steps
    // throw ApifyApiError/provider errors, never McpError), so classifying every throw is correct.
    try {
        // Decode dot property names in arguments before validation,
        // since validation expects the original, non-encoded property names.
        args = decodeDotPropertyNames(args as Record<string, unknown>) as Record<string, unknown>;
        decodedArgs = args as Record<string, unknown>;

        // Centralize all payment processing: validate, strip payment fields, create client.
        // Must run before AJV validation so toolArgsWithoutPayment doesn't contain provider-specific fields.
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
            requestOrigin: getRequestOriginForClient(options.initializeRequestData),
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

        // Check if tool call is a long-running task and the tool supports that
        // Cast to allowed task mode types ('optional' | 'required') for type-safe includes() check
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

        // Standby / MCP-server Actors are never payable via a third-party provider —
        // compute the rejection here so both the sync short-circuit and the task path
        // can use it. In task-mode we still create the task and store this rejection
        // as its result (instead of a generic 402), so the agent gets the precise reason
        // when fetching the task result. Task-mode `call-actor` declares
        // `taskSupport: 'optional'`, so without this both paths would 402 by default.
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
        // A non-McpError throw after tool resolution. Classify it with the actor context already in
        // scope, reusing the shared classifier, so the shell interprets it like any other outcome and
        // telemetry + logHttpError carry actor_name/actor_id — byte-identical to base's outer catch.
        const outcome = classifyToolCallError(error, {
            apifyMcpServer,
            toolName: name,
            failingToolName: resolvedToolName,
            actorName,
            actorId,
            isAborted: Boolean(params.extra?.signal?.aborted),
            mcpSessionId: params.mcpSessionId,
        });
        return { ...outcome, resolvedToolName, decodedArgs };
    }
}

/**
 * The synchronous dispatch tail: pre-flight short-circuit → progress-tracker opt-in → dispatch →
 * error classification → report-problem nudge. Returns a `ToolCallOutcome` whose `result` is the exact
 * wire payload (nudge already applied). Owns the APPROVAL/EXECUTION `logHttpError` side-effects, so the
 * v1 shell stays purely interpretive. Imports no SDK error type.
 */
export async function executeSyncToolCall(
    prepared: PreparedCall,
    params: {
        apifyMcpServer: ActorsMcpServer;
        apifyToken: string;
        toolName: string;
        mcpSessionId: string | undefined;
        progressToken: string | number | undefined;
        extra: RequestHandlerExtra<Request, Notification>;
    },
): Promise<ToolCallOutcome> {
    const { apifyMcpServer, apifyToken, toolName, mcpSessionId, progressToken, extra } = params;
    const { tool, toolArgs, logSafeArgs, apifyClient, actorName, actorId, standbyRejection, paymentRequiredResult } =
        prepared;
    const resolvedToolName = getToolFullName(tool);

    // On a failed result, nudge the agent to report the blocker via report-problem at the moment it
    // decides what to do next. Gated on the tool actually being served (see isReportProblemServable),
    // so clients where it is blocklisted or telemetry is off never see it.
    const nudge = (result: unknown, callDiagnostics: CallDiagnostics): Record<string, unknown> =>
        withReportProblemNudge({
            result,
            tools: apifyMcpServer.tools,
            failingToolName: resolvedToolName,
            failureCategory: callDiagnostics.failure_category,
            failureHttpStatus: callDiagnostics.failure_http_status,
        }) as Record<string, unknown>;

    // Sync path: short-circuit on either pre-flight failure. buildPreflightFailureOutcome
    // encodes the precedence — standby rejection wins over the generic payment-required
    // 402, so the agent gets the precise reason.
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
        return classifyToolCallError(error, {
            apifyMcpServer,
            toolName,
            failingToolName: resolvedToolName,
            actorName,
            actorId,
            isAborted: Boolean(extra.signal?.aborted),
            mcpSessionId,
        });
    }
}

/**
 * Classifies a thrown tool-call error into a v1 tool result, reusing the shared
 * `buildToolCallErrorResult` mapper. Owns the APPROVAL/EXECUTION `logHttpError` side-effects and
 * applies the report-problem nudge, so the returned `result` is the exact wire payload. Both the sync
 * dispatch tail (`executeSyncToolCall`'s catch) and the v1 shell's outer catch (prep-spine and
 * task-branch `createTask` throws) route through this, so any non-`McpError` throw is classified
 * identically wherever it originates. Imports no SDK error type.
 */
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
    },
): ToolCallOutcome {
    const { apifyMcpServer, toolName, failingToolName, actorName, actorId, isAborted, mcpSessionId } = params;

    const nudge = (result: unknown, callDiagnostics: CallDiagnostics): Record<string, unknown> =>
        withReportProblemNudge({
            result,
            tools: apifyMcpServer.tools,
            failingToolName,
            failureCategory: callDiagnostics.failure_category,
            failureHttpStatus: callDiagnostics.failure_http_status,
        }) as Record<string, unknown>;

    const errorResult = buildToolCallErrorResult(error, { toolName, actorName, actorId, isAborted });
    const { toolStatus } = errorResult;

    switch (errorResult.kind) {
        case TOOL_CALL_ERROR_KIND.PAYMENT: {
            // Propagate 402 Payment Required as a tool result per x402 MCP transport spec:
            // content[0].text (JSON) + isError: true. No log here (unlike the task path). The
            // concurrent-run limit also surfaces as 402 but is excluded by the predicate and
            // falls through to the generic run-limit handling below.
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
                // Spread the actor fields first, then overwrite with the mapper's freshly computed
                // fields so they take precedence.
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
            // This framework outer-catch path bypasses extractToolTelemetry, so preserve the
            // pre-existing wire shape { toolStatus } exactly: reuse the local ABORTED-aware
            // toolStatus, do NOT re-derive from the error (which would drop ABORTED and leak
            // failureCategory/failureHttpStatus onto the wire).
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
            // Compile-time exhaustiveness guard (same `satisfies never` idiom as dispatchToolCall's
            // default arm): a new TOOL_CALL_ERROR_KIND makes `errorResult` non-`never` here and
            // fails to compile. Unreachable at runtime.
            throw new Error(
                `Unknown tool-call error kind "${(errorResult satisfies never as ToolCallErrorResult).kind}"`,
            );
    }
}
