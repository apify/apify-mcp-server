import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { Notification, Request } from '@modelcontextprotocol/sdk/types.js';
import {
    CallToolResultSchema,
    ErrorCode,
    McpError,
    ServerNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import dedent from 'dedent';

import log from '@apify/log';

import type { ApifyClient } from '../apify_client.js';
import { FAILURE_CATEGORY, TOOL_STATUS } from '../const.js';
import { actorExecutor } from '../tools/actors/actor_executor.js';
import type { CallDiagnostics, ToolEntry, ToolStatus } from '../types.js';
import { TOOL_TYPE } from '../types.js';
import { remoteMcpFailureDetail } from '../utils/apify_errors.js';
import { logHttpError } from '../utils/logging.js';
import { respondErrorNoTelemetry } from '../utils/mcp.js';
import type { createProgressTracker } from '../utils/progress.js';
import { applyToolTelemetry, buildExecutionDiagnostics } from '../utils/tool_status.js';
import { buildActorFields } from '../utils/tools.js';
import { connectMCPClient } from './client.js';
import { EXTERNAL_TOOL_CALL_TIMEOUT_MSEC } from './const.js';
import type { ActorsMcpServer } from './server.js';

/**
 * Runs a validated tool call through the single tool-type dispatch switch and returns the raw
 * result plus derived telemetry. The exhaustive switch turns a future 4th TOOL_TYPE into a compile
 * error (same `satisfies never` idiom as getToolFullName) instead of a silent runtime fall-through.
 * Both the sync `CallToolRequestSchema` handler and `executeToolAndUpdateTask` call this after their
 * own pre-dispatch validation and keep their own try/catch + buildToolCallErrorResult around it.
 * INTERNAL and ACTOR execution errors propagate to the caller's catch; the ACTOR_MCP case keeps its
 * own inner catch and returns a soft-fail result instead of throwing.
 *
 * `extractToolTelemetry` (via `applyToolTelemetry`) runs once here, in the INTERNAL and ACTOR
 * cases, and strips `toolTelemetry` in place, so callers must not re-strip. ACTOR_MCP sets
 * telemetry manually instead. The caller constructs `progressTracker`; dispatch consumes it and stops
 * it in the branch `finally`. The abort source is `extra.signal`: the request signal for sync; the
 * task caller passes a `taskExtra` whose `signal` is the cancel watcher's, so a client disconnect
 * never cancels a task. `shouldForwardNotifications` gates only the ACTOR_MCP raw-notification
 * forwarder (true for sync, false for task, whose originating request is already answered).
 * `taskMode` is a passthrough to `tool.call` / `executeActorTool`, never a dispatch selector.
 */
export async function dispatchToolCall(params: {
    tool: ToolEntry;
    toolArgs: Record<string, unknown>;
    logSafeArgs: unknown;
    apifyToken: string;
    apifyClient: ApifyClient;
    apifyMcpServer: ActorsMcpServer;
    mcpSessionId: string | undefined;
    progressToken: string | number | undefined;
    progressTracker: ReturnType<typeof createProgressTracker>;
    shouldForwardNotifications: boolean;
    extra: RequestHandlerExtra<Request, Notification>;
    actorName?: string;
    actorId?: string;
    taskMode: boolean;
    // Caller-supplied log decoration (task mode: ' for task' suffix + taskId field), applied
    // mechanically to the per-branch "Calling …" lines — no effect on dispatch behavior.
    logContext?: { messageSuffix: string; fields: Record<string, unknown> };
    // Client-facing side-channel for the ACTOR_MCP connect-failure soft-fail. Defaults to the
    // server's `sendLoggingMessage`, keeping the hard `.server` coupling off the shared leaf so a
    // future shell (with no session transport) can pass a no-op.
    emitLog?: (msg: { level: string; data?: unknown }) => Promise<void>;
}): Promise<{ result: Record<string, unknown>; toolStatus: ToolStatus; callDiagnostics: CallDiagnostics }> {
    const {
        tool,
        toolArgs,
        logSafeArgs,
        apifyToken,
        apifyClient,
        apifyMcpServer,
        mcpSessionId,
        progressToken,
        progressTracker,
        shouldForwardNotifications,
        extra,
        actorName,
        actorId,
        taskMode,
        logContext,
        emitLog = async (msg) =>
            apifyMcpServer.server.sendLoggingMessage(
                msg as Parameters<typeof apifyMcpServer.server.sendLoggingMessage>[0],
            ),
    } = params;

    let result: Record<string, unknown> = {};
    let toolStatus: ToolStatus = TOOL_STATUS.SUCCEEDED;
    // Always populate actor fields so they're tracked on both success and failure paths.
    let callDiagnostics: CallDiagnostics = { ...buildActorFields(actorName, actorId) };

    switch (tool.type) {
        case TOOL_TYPE.INTERNAL: {
            try {
                log.info(`Calling internal tool${logContext?.messageSuffix ?? ''}`, {
                    ...logContext?.fields,
                    toolName: tool.name,
                    mcpSessionId,
                    input: logSafeArgs,
                });
                const res = (await tool.call({
                    args: toolArgs,
                    extra,
                    apifyMcpServer,
                    mcpServer: apifyMcpServer.server,
                    apifyToken,
                    apifyClient,
                    progressTracker,
                    mcpSessionId,
                    taskMode,
                })) as Record<string, unknown>;

                // Extract diagnostics and strip internal fields from res before returning to client.
                ({ toolStatus, callDiagnostics } = applyToolTelemetry(res, actorName, actorId, callDiagnostics));
                result = res;
            } finally {
                progressTracker?.stop();
            }
            break;
        }

        case TOOL_TYPE.ACTOR_MCP: {
            // This case never throws: connect/exec failures resolve to a soft-fail `result`
            // (isError body) below instead. As a task, that means the outer completeTask
            // stores it via the 'completed' path (isError body) — deliberately matching sync's
            // own soft-fail semantics, unlike ACTOR/INTERNAL, whose thrown errors land in the
            // task caller's 'failed' path.
            let client: Client | null = null;
            try {
                client = await connectMCPClient(tool.serverUrl, apifyToken, mcpSessionId);
                if (!client) {
                    const msg = dedent`
                        Failed to connect to MCP server at "${tool.serverUrl}".
                        Please verify the server URL is correct and accessible, and ensure you have a valid Apify token with appropriate permissions.
                    `;
                    log.softFail(msg, { mcpSessionId, failureCategory: FAILURE_CATEGORY.INTERNAL_ERROR });
                    await emitLog({ level: 'error', data: msg });
                    toolStatus = TOOL_STATUS.SOFT_FAIL;
                    callDiagnostics = { ...callDiagnostics, failure_category: FAILURE_CATEGORY.INTERNAL_ERROR };
                    result = respondErrorNoTelemetry(msg);
                    break;
                }

                // Only set up notification handlers if progressToken is provided by the client.
                // Gated off for tasks (shouldForwardNotifications=false): the originating request is
                // already answered, so forwarding against its progressToken would misroute.
                if (shouldForwardNotifications && progressToken !== undefined && progressToken !== null) {
                    // Set up notification handlers for the client
                    for (const schema of ServerNotificationSchema.options) {
                        const method = schema.shape.method.value;
                        // Forward notifications from the proxy client to the server
                        client.setNotificationHandler(schema, async (notification) => {
                            log.debug('Sending MCP notification', {
                                method,
                                mcpSessionId,
                                notification,
                            });
                            await extra.sendNotification(notification);
                        });
                    }
                }

                log.info(`Calling Actor-MCP${logContext?.messageSuffix ?? ''}`, {
                    ...logContext?.fields,
                    toolName: tool.name,
                    actorMcpToolName: tool.originToolName,
                    actorId: tool.actorId,
                    mcpSessionId,
                    input: logSafeArgs,
                });
                const res = await client.callTool(
                    {
                        name: tool.originToolName,
                        arguments: toolArgs,
                        // Without forwarding there is no route back for remote progress — don't
                        // hand the remote a token nobody listens to.
                        ...(shouldForwardNotifications ? { _meta: { progressToken } } : {}),
                    },
                    CallToolResultSchema,
                    {
                        timeout: EXTERNAL_TOOL_CALL_TIMEOUT_MSEC,
                    },
                );

                // TODO: actor-mcp responses are opaque — isError could be a user input problem
                // (e.g. invalid query) or a genuine server failure. We can't distinguish without
                // parsing the error text. Defaulting to INTERNAL_ERROR for now; revisit when
                // actor-mcp gets deeper telemetry treatment.
                if ('isError' in res && res.isError) {
                    toolStatus = TOOL_STATUS.SOFT_FAIL;
                    callDiagnostics = {
                        failure_category: FAILURE_CATEGORY.INTERNAL_ERROR,
                        ...buildActorFields(actorName, actorId),
                    };
                }

                result = { ...res };
            } catch (error) {
                ({ toolStatus, callDiagnostics } = buildExecutionDiagnostics({
                    error,
                    isAborted: Boolean(extra.signal?.aborted),
                    actorName,
                    actorId,
                }));
                logHttpError(error, `Failed to call MCP tool '${tool.originToolName}' on Actor '${tool.actorId}'`, {
                    actorId: tool.actorId,
                    toolName: tool.originToolName,
                    failureCategory: callDiagnostics.failure_category,
                });
                result = respondErrorNoTelemetry(
                    `Failed to call MCP tool '${tool.originToolName}' on Actor '${tool.actorId}': ${remoteMcpFailureDetail(error)}`,
                );
            } finally {
                if (client) await client.close();
            }
            break;
        }

        case TOOL_TYPE.ACTOR: {
            try {
                log.info(`Calling Actor${logContext?.messageSuffix ?? ''}`, {
                    ...logContext?.fields,
                    toolName: tool.name,
                    actorName: tool.actorFullName,
                    mcpSessionId,
                    input: logSafeArgs,
                });
                const executorResult = await actorExecutor.executeActorTool({
                    actorFullName: tool.actorFullName,
                    input: toolArgs,
                    apifyClient,
                    callOptions: { memory: tool.memoryMbytes },
                    progressTracker,
                    abortSignal: extra.signal,
                    mcpSessionId,
                    datasetItemsSchema: tool.datasetItemsSchema,
                    taskMode,
                });

                if (!executorResult) {
                    toolStatus = TOOL_STATUS.ABORTED;
                    // Receivers of cancellation notifications SHOULD NOT send a response for the cancelled request
                    // https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation#behavior-requirements
                    result = {};
                    break;
                }

                // Mirror the INTERNAL branch: read the telemetry the executor embedded on error
                // results (e.g. respondUserError → SOFT_FAIL/INVALID_INPUT), strip it from the wire,
                // and set failure_category so the report-problem nudge picks the softer variant.
                ({ toolStatus, callDiagnostics } = applyToolTelemetry(
                    executorResult as Record<string, unknown>,
                    actorName,
                    actorId,
                    callDiagnostics,
                ));
                result = executorResult;
            } finally {
                if (progressTracker) {
                    progressTracker.stop();
                }
            }
            break;
        }

        default:
            // Exhaustiveness guard mirroring getToolFullName: a new TOOL_TYPE member makes `tool`
            // non-`never` here and fails `satisfies never` at compile time. Unreachable at runtime —
            // ToolEntry is a closed 3-way union. Unlike the pre-extraction fall-through (which also
            // listed available tools, called log.softFail, and sent a logging message before
            // throwing), this just throws InvalidParams with no side effects.
            throw new McpError(
                ErrorCode.InvalidParams,
                `Unknown tool type "${(tool satisfies never as ToolEntry).type}"`,
            );
    }

    return { result, toolStatus, callDiagnostics };
}
