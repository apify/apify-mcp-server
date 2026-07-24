import type { TaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/interfaces.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { Notification, Request, TaskStatusNotification } from '@modelcontextprotocol/sdk/types.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import log from '@apify/log';

import type { ApifyClient } from '../apify_client.js';
import { FAILURE_CATEGORY, TOOL_STATUS } from '../const.js';
import { withReportProblemNudge } from '../tools/dev/report_problem.js';
import type { CallDiagnostics, ToolEntry, ToolStatus } from '../types.js';
import { TOOL_TYPE } from '../types.js';
import { logHttpError, sanitizeMezmoMessage } from '../utils/logging.js';
import { createProgressTracker } from '../utils/progress.js';
import { buildActorFields, getToolFullName } from '../utils/tools.js';
import type { McpClientContext } from './client_context.js';
import type { ActorsMcpServer } from './server.js';
import { buildToolCallErrorResult, TOOL_CALL_ERROR_KIND } from './tool_call_error_mapper.js';
import type { ToolCallErrorResult } from './tool_call_error_mapper.js';
import { logToolCallAndTelemetry, prepareTelemetryData } from './tool_call_telemetry.js';
import { dispatchToolCall } from './tool_dispatch.js';
import {
    createTaskCancellationWatcher,
    isTaskCancelled,
    isTaskNotFoundError,
    storeTaskResultOrSkipIfExpired,
} from './utils.js';

/** Send notifications/tasks/status for taskId. Routes via session transport (no relatedRequestId).
 *  Swallows errors — notifications are advisory. */
export async function emitTaskStatusNotification(
    taskId: string,
    mcpSessionId: string | undefined,
    taskStore: TaskStore,
    server: Server,
): Promise<void> {
    try {
        const task = await taskStore.getTask(taskId, mcpSessionId);
        if (!task) return;
        // Per spec: notifications/tasks/status MUST NOT carry _meta.related-task (task ID is in params).
        // Called without options so the notification routes through the session transport,
        // not the request-scoped stream (which closes once the initial { task } response is flushed).
        await server.notification({
            method: 'notifications/tasks/status',
            params: {
                taskId: task.taskId,
                status: task.status,
                createdAt: task.createdAt,
                lastUpdatedAt: task.lastUpdatedAt,
                ttl: task.ttl,
                ...(task.statusMessage != null && { statusMessage: task.statusMessage }),
                ...(task.pollInterval != null && { pollInterval: task.pollInterval }),
            },
        } as TaskStatusNotification);
    } catch {
        // Silent fail — notifications are advisory
    }
}

// TODO: outer orchestration here (pre-flight, telemetry bookkeeping, task-store handling) still duplicates the CallToolRequestSchema handler's logic; the dispatch ladder is now shared. Refactor.
/**
 * Executes a tool asynchronously for a long-running task and updates task status.
 *
 * @param params - Tool execution parameters
 * @param params.taskId - The task identifier
 * @param params.tool - The tool to execute
 * @param params.toolArgs - Tool arguments
 * @param params.logSafeArgs - Tool arguments with sensitive fields redacted, safe for logging
 * @param params.apifyClient - ApifyClient configured with payment headers or the standard token
 * @param params.apifyToken - Apify API token
 * @param params.progressToken - Progress token for notifications
 * @param params.extra - Extra request handler context
 * @param params.mcpSessionId - MCP session ID for telemetry
 * @param params.actorName - Actor name, used for telemetry and error diagnostics
 * @param params.actorId - Actor ID, used for telemetry and error diagnostics
 * @param params.apifyMcpServer - The ActorsMcpServer instance (task store, server, tools, telemetry config)
 */

export async function executeToolAndUpdateTask(params: {
    taskId: string;
    tool: ToolEntry;
    toolArgs: Record<string, unknown>;
    logSafeArgs: unknown;
    apifyClient: ApifyClient;
    apifyToken: string;
    progressToken: string | number | undefined;
    extra: RequestHandlerExtra<Request, Notification>;
    mcpSessionId: string | undefined;
    actorName?: string;
    actorId?: string;
    apifyMcpServer: ActorsMcpServer;
    clientContext: McpClientContext | undefined;
}): Promise<void> {
    const {
        taskId,
        tool,
        toolArgs,
        logSafeArgs,
        apifyClient,
        apifyToken,
        progressToken,
        extra,
        mcpSessionId,
        actorName,
        actorId,
        apifyMcpServer,
        clientContext,
    } = params;
    let toolStatus: ToolStatus = TOOL_STATUS.SUCCEEDED;
    // Always populate actor fields so they're tracked on both success and failure paths.
    let callDiagnostics: CallDiagnostics = { ...buildActorFields(actorName, actorId) };
    const startTime = Date.now();

    log.debug('[executeToolAndUpdateTask] Starting task execution', {
        taskId,
        toolName: tool.name,
        mcpSessionId,
    });

    // Prepare telemetry before try-catch so it's accessible to both paths.
    // This avoids re-fetching user data in the error handler.
    const { telemetryData, userId } = await prepareTelemetryData({
        toolName: getToolFullName(tool),
        mcpSessionId,
        apifyToken,
        apifyMcpServer,
        clientContext,
    });

    const finishTaskTracking = (status: ToolStatus, diagnostics?: CallDiagnostics, result?: unknown) => {
        logToolCallAndTelemetry({
            toolName: tool.name,
            mcpSessionId,
            toolStatus: status,
            startTime,
            taskId,
            telemetryData,
            userId,
            callDiagnostics: diagnostics,
            args: toolArgs,
            result,
            apifyMcpServer,
        });
    };

    // Terminal step shared by every task outcome: store the result (expiry-tolerant),
    // emit the status notification, record telemetry.
    const completeTask = async (
        storeStatus: 'completed' | 'failed',
        taskResult: Record<string, unknown>,
        status: ToolStatus,
        diagnostics: CallDiagnostics | undefined,
    ): Promise<void> => {
        await storeTaskResultOrSkipIfExpired(
            apifyMcpServer.taskStore,
            tool.name,
            taskId,
            storeStatus,
            taskResult,
            mcpSessionId,
        );
        await emitTaskStatusNotification(taskId, mcpSessionId, apifyMcpServer.taskStore, apifyMcpServer.server);
        finishTaskTracking(status, diagnostics, taskResult);
    };

    // Once a task is cancelled the spec forbids writing a result; every storage path
    // must short-circuit here. `logSuffix` is concatenated after "Task was cancelled"
    // so we keep the existing log format and the existing telemetry status per path.
    const skipIfTaskCancelled = async (
        logSuffix: string,
        status: ToolStatus,
        diagnostics?: CallDiagnostics,
    ): Promise<boolean> => {
        if (!(await isTaskCancelled(taskId, mcpSessionId, apifyMcpServer.taskStore))) return false;
        log.debug(`[executeToolAndUpdateTask] Task was cancelled${logSuffix}`, { taskId, mcpSessionId });
        finishTaskTracking(status, diagnostics);
        return true;
    };

    // Bridges MCP `tasks/cancel` to the running handler: when the client
    // explicitly cancels the task, this signal aborts so the underlying
    // Actor run stops instead of consuming compute until natural completion.
    // Per MCP tasks spec, request-level aborts (client disconnect,
    // notifications/cancelled for the original request ID) MUST NOT cancel
    // the task — `extra.signal` is intentionally not chained here.
    const cancelWatcher = createTaskCancellationWatcher({
        taskId,
        mcpSessionId,
        taskStore: apifyMcpServer.taskStore,
    });
    const taskExtra = { ...extra, signal: cancelWatcher.signal };

    try {
        log.debug('[executeToolAndUpdateTask] Updating task status to working', {
            taskId,
            mcpSessionId,
        });
        // The store rejects terminal → 'working' transitions. If `tasks/cancel` raced
        // with us (between handler dispatch and the first watcher tick at ~500 ms),
        // updateTaskStatus throws — re-check the store to tell a clean cancel-race
        // apart from a genuine store error.
        // noinspection ExceptionCaughtLocallyJS
        try {
            await apifyMcpServer.taskStore.updateTaskStatus(taskId, 'working', undefined, mcpSessionId);
        } catch (err) {
            if (
                await skipIfTaskCancelled(' before execution started, skipping', TOOL_STATUS.ABORTED, {
                    ...buildActorFields(actorName, actorId),
                })
            )
                return;
            throw err;
        }
        await emitTaskStatusNotification(taskId, mcpSessionId, apifyMcpServer.taskStore, apifyMcpServer.server);

        // Execute the tool and get the result
        let result: Record<string, unknown> = {};

        // Callback to propagate Actor run statusMessage into the task store and emit a push notification.
        // TODO(TC-3): cancel arriving while this is scheduled throws cancelled → working;
        // currently swallowed by progress.ts's tick catch — guard or catch explicitly.
        const onStatusMessage = async (message: string) => {
            await apifyMcpServer.taskStore.updateTaskStatus(taskId, 'working', message, mcpSessionId);
            await emitTaskStatusNotification(taskId, mcpSessionId, apifyMcpServer.taskStore, apifyMcpServer.server);
        };

        // ACTOR_MCP never reads the tracker (matching the sync path, which passes null for it);
        // INTERNAL/ACTOR get one built from taskId + onStatusMessage, which dispatch consumes
        // and stops.
        const progressTracker =
            tool.type === TOOL_TYPE.ACTOR_MCP
                ? null
                : createProgressTracker(progressToken, extra.sendNotification, taskId, onStatusMessage);
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
            shouldForwardNotifications: false,
            extra: taskExtra,
            actorName,
            actorId,
            taskMode: true,
            logContext: { messageSuffix: ' for task', fields: { taskId } },
        });
        result = dispatchResult.result;
        toolStatus = dispatchResult.toolStatus;
        callDiagnostics = dispatchResult.callDiagnostics;

        // Check if task was cancelled before storing result
        if (await skipIfTaskCancelled(', skipping result storage', toolStatus)) return;

        // On a failed result, nudge the agent to report the blocker via report-problem (mirrors the
        // synchronous CallTool path, which task-mode calls like call-actor bypass).
        result = withReportProblemNudge({
            result,
            tools: apifyMcpServer.tools,
            failingToolName: tool.name,
            failureCategory: callDiagnostics.failure_category,
            failureHttpStatus: callDiagnostics.failure_http_status,
        });

        // Store the result in the task store
        log.debug('[executeToolAndUpdateTask] Storing completed result', {
            taskId,
            mcpSessionId,
        });
        await completeTask('completed', result, toolStatus, callDiagnostics);
        log.debug('Task completed successfully', { taskId, toolName: tool.name, mcpSessionId });
    } catch (error) {
        // Reached only when the task expired before the `working` transition (updateTaskStatus
        // above rethrows the store's unknown-taskId error). The tool never ran and the task is
        // gone, so soft-fail, record telemetry, and stop. Every result store (success and error
        // paths) tolerates expiry via storeTaskResultOrSkipIfExpired, so they don't reach here.
        if (isTaskNotFoundError(error)) {
            log.softFail('Task expired before execution started', {
                taskId,
                toolName: tool.name,
                mcpSessionId,
            });
            finishTaskTracking(TOOL_STATUS.SOFT_FAIL, {
                failure_category: FAILURE_CATEGORY.INTERNAL_ERROR,
                ...buildActorFields(actorName, actorId),
            });
            return;
        }

        const errorResult = buildToolCallErrorResult(error, {
            toolName: tool.name,
            actorName,
            actorId,
            isAborted: Boolean(cancelWatcher.signal.aborted),
        });

        switch (errorResult.kind) {
            case TOOL_CALL_ERROR_KIND.PAYMENT: {
                // Handle 402 Payment Required — return structured x402 result so clients can auto-pay
                logHttpError(error, 'Payment required while calling tool (task mode)', { toolName: tool.name });
                // Per MCP tasks spec: once a task is cancelled it MUST remain cancelled,
                // so guard storeTaskResult against a cancel that raced with this 402.
                if (
                    await skipIfTaskCancelled(', skipping 402 result storage', TOOL_STATUS.ABORTED, {
                        ...buildActorFields(actorName, actorId),
                    })
                )
                    return;
                await completeTask(
                    'completed',
                    errorResult.response,
                    errorResult.toolStatus,
                    errorResult.callDiagnostics,
                );
                return;
            }
            case TOOL_CALL_ERROR_KIND.APPROVAL: {
                logHttpError(error, 'Permission approval required while calling tool (task mode)', {
                    toolName: tool.name,
                });
                // Per MCP tasks spec: once a task is cancelled it MUST remain cancelled,
                // so guard storeTaskResult against a cancel that raced with this approval error.
                if (
                    await skipIfTaskCancelled(', skipping permission-approval result storage', TOOL_STATUS.ABORTED, {
                        ...buildActorFields(actorName, actorId),
                    })
                )
                    return;
                await completeTask(
                    'completed',
                    errorResult.response,
                    errorResult.toolStatus,
                    errorResult.callDiagnostics,
                );
                return;
            }
            case TOOL_CALL_ERROR_KIND.EXECUTION: {
                toolStatus = errorResult.toolStatus;
                callDiagnostics = errorResult.callDiagnostics;
                // Log level follows the already-classified toolStatus:
                //   SOFT_FAIL (e.g. 402/403 user quota, client-side issues) → softFail
                //   FAILED/ABORTED/other                                    → error
                if (toolStatus === TOOL_STATUS.SOFT_FAIL) {
                    // Mezmo promotes on "error" in message/keys — use errMessage key, sanitized.
                    const errMessage = sanitizeMezmoMessage(error instanceof Error ? error.message : String(error));
                    log.softFail('Tool execution soft-failed for task', {
                        taskId,
                        toolName: tool.name,
                        toolStatus,
                        mcpSessionId,
                        failureCategory: callDiagnostics.failure_category,
                        failureHttpStatus: callDiagnostics.failure_http_status,
                        actorName: callDiagnostics.actor_name,
                        errMessage,
                    });
                } else {
                    log.error('Error executing tool for task', {
                        taskId,
                        toolName: tool.name,
                        toolStatus,
                        mcpSessionId,
                        failureCategory: callDiagnostics.failure_category,
                        failureHttpStatus: callDiagnostics.failure_http_status,
                        actorName: callDiagnostics.actor_name,
                        error,
                    });
                }
                const { userText } = errorResult;

                // Check if task was cancelled before storing result
                if (await skipIfTaskCancelled(', skipping result storage', toolStatus, callDiagnostics)) return;

                log.debug('[executeToolAndUpdateTask] Storing failed result', {
                    taskId,
                    mcpSessionId,
                });
                // Nudge on a genuinely-failed task result (mirrors the completed path and the sync
                // captureResult). INTERNAL_ERROR and an unknown category get the full nudge; a genuine
                // INVALID_INPUT gets the softer nudge; payment (402) is suppressed via the HTTP status and
                // AUTH / PERMISSION_APPROVAL_REQUIRED via NON_NUDGE_FAILURE_CATEGORIES. The 402 branch above
                // returns before reaching here, so this only sees non-payment failures.
                const failedResult = withReportProblemNudge({
                    result: {
                        content: [
                            {
                                type: 'text' as const,
                                text: userText,
                            },
                        ],
                        isError: true,
                        internalToolStatus: toolStatus,
                    },
                    tools: apifyMcpServer.tools,
                    failingToolName: tool.name,
                    failureCategory: callDiagnostics.failure_category,
                    failureHttpStatus: callDiagnostics.failure_http_status,
                });
                await completeTask('failed', failedResult, toolStatus, callDiagnostics);
                break;
            }
            default:
                // Compile-time exhaustiveness guard (same `satisfies never` idiom as dispatchToolCall's
                // default arm): a new TOOL_CALL_ERROR_KIND makes `errorResult` non-`never` here and fails
                // to compile. Unreachable at runtime.
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Unknown tool-call error kind "${(errorResult satisfies never as ToolCallErrorResult).kind}"`,
                );
        }
    } finally {
        cancelWatcher.dispose();
    }
}
