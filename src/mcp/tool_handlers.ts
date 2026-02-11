import { randomUUID } from 'node:crypto';

import type { TaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/interfaces.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { Notification, Request } from '@modelcontextprotocol/sdk/types.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';

import log from '@apify/log';

import { TOOL_STATUS } from '../const.js';
import type {
    ActorMcpTool,
    ActorsMcpServerOptions,
    ActorTool,
    ApifyRequestParams,
    HelperTool,
    ToolCallTelemetryProperties,
    ToolEntry,
    ToolStatus,
} from '../types.js';
import { logHttpError } from '../utils/logging.js';
import { buildMCPResponse } from '../utils/mcp.js';
import { getToolStatusFromError } from '../utils/tool-status.js';
import { getToolPublicFieldOnly } from '../utils/tools.js';
import type { ActorsMcpServer } from './server.js';
import { validateAndPrepareToolCall } from './tool_call_validation.js';
import { executeToolForCall, executeToolForTask } from './tool_execution.js';
import { isTaskCancelled } from './utils.js';

type ToolCallRequest = {
    params: ApifyRequestParams & {
        name: string;
        arguments?: Record<string, unknown>;
    };
};

type PrepareTelemetryDataFn = (
    tool: HelperTool | ActorTool | ActorMcpTool,
    mcpSessionId: string | undefined,
    apifyToken: string,
) => Promise<{ telemetryData: ToolCallTelemetryProperties | null; userId: string | null }>;

type FinalizeTelemetryFn = (
    telemetryData: ToolCallTelemetryProperties | null,
    userId: string | null,
    startTime: number,
    toolStatus: ToolStatus,
) => void;

type RegisterToolHandlersParams = {
    server: Server;
    tools: Map<string, ToolEntry>;
    options: ActorsMcpServerOptions;
    taskStore: TaskStore;
    apifyMcpServer: ActorsMcpServer;
    listToolNames: () => string[];
    prepareTelemetryData: PrepareTelemetryDataFn;
    finalizeAndTrackTelemetry: FinalizeTelemetryFn;
};

type ExecuteToolAndUpdateTaskParams = {
    taskId: string;
    tool: ToolEntry;
    args: Record<string, unknown>;
    apifyToken: string;
    progressToken: string | number | undefined;
    extra: RequestHandlerExtra<Request, Notification>;
    mcpSessionId: string | undefined;
    userRentedActorIds?: string[];
    taskStore: TaskStore;
    server: Server;
    apifyMcpServer: ActorsMcpServer;
    prepareTelemetryData: PrepareTelemetryDataFn;
    finalizeAndTrackTelemetry: FinalizeTelemetryFn;
};

/**
 * Registers MCP tool handlers (tools/list and tools/call).
 */
export function registerToolHandlers({
    server,
    tools,
    options,
    taskStore,
    apifyMcpServer,
    listToolNames,
    prepareTelemetryData,
    finalizeAndTrackTelemetry,
}: RegisterToolHandlersParams): void {
    /**
     * Handles the request to list tools.
     * @param {object} request - The request object.
     * @returns {object} - The response object containing the tools.
     */
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        const resolvedTools = Array.from(tools.values()).map((tool) => getToolPublicFieldOnly(tool, {
            uiMode: options.uiMode,
            filterOpenAiMeta: true,
        }));
        return { tools: resolvedTools };
    });

    /**
     * Handles the request to call a tool.
     * @param {object} request - The request object containing tool name and arguments.
     * @param {object} extra - Extra data given to the request handler, such as sendNotification function.
     * @throws {McpError} - based on the McpServer class code from the typescript MCP SDK
     */
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        // TODO: we should split this huge method into smaller parts as it is slowly getting out of hand
        const {
            name,
            args,
            tool,
            apifyToken,
            progressToken,
            userRentedActorIds,
            mcpSessionId,
            task: taskParams,
        } = await validateAndPrepareToolCall({
            request: request as ToolCallRequest,
            options,
            tools,
            server,
            listToolNames,
        });

        // Handle long-running task request
        if (taskParams) {
            const task = await taskStore.createTask(
                {
                    ttl: taskParams.ttl,
                },
                `call-tool-${name}-${randomUUID()}`,
                request,
            );
            log.debug('Created task for tool execution', { taskId: task.taskId, toolName: tool.name, mcpSessionId });

            // Execute the tool asynchronously and update task status
            setImmediate(async () => {
                await executeToolAndUpdateTask({
                    taskId: task.taskId,
                    tool,
                    args,
                    apifyToken,
                    progressToken,
                    extra,
                    mcpSessionId,
                    userRentedActorIds,
                    taskStore,
                    server,
                    apifyMcpServer,
                    prepareTelemetryData,
                    finalizeAndTrackTelemetry,
                });
            });

            // Return task immediately; execution continues asynchronously
            return { task };
        }

        const { telemetryData, userId } = await prepareTelemetryData(tool, mcpSessionId, apifyToken);
        const startTime = Date.now();
        let toolStatus: ToolStatus = TOOL_STATUS.SUCCEEDED;

        try {
            const toolExecutionResult = await executeToolForCall({
                tool,
                args,
                apifyToken,
                progressToken,
                extra,
                mcpSessionId,
                userRentedActorIds,
                apifyMcpServer,
                mcpServer: server,
            });

            toolStatus = toolExecutionResult.toolStatus;
            if (toolExecutionResult.handled) {
                return toolExecutionResult.response ?? {};
            }
        } catch (error) {
            toolStatus = getToolStatusFromError(error, Boolean(extra.signal?.aborted));
            logHttpError(error, 'Error occurred while calling tool', { toolName: name });
            const errorMessage = (error instanceof Error) ? error.message : 'Unknown error';
            return buildMCPResponse({
                texts: [`Error calling tool "${name}": ${errorMessage}.  Please verify the tool name, input parameters, and ensure all required resources are available.`],
                isError: true,
                toolStatus,
            });
        } finally {
            finalizeAndTrackTelemetry(telemetryData, userId, startTime, toolStatus);
        }

        const availableTools = listToolNames();
        const msg = `Unknown tool type for "${name}".
Available tools: ${availableTools.length > 0 ? availableTools.join(', ') : 'none'}.
Please verify the tool name and ensure the tool is properly registered.`;
        log.softFail(msg, { mcpSessionId, statusCode: 404 });
        await server.sendLoggingMessage({
            level: 'error',
            data: msg,
        });
        throw new McpError(
            ErrorCode.InvalidParams,
            msg,
        );
    });
}

// TODO: this function quite duplicates the main tool call login the CallToolRequestSchema handler, we should refactor
/**
 * Executes a tool asynchronously for a long-running task and updates task status.
 *
 * @param params - Tool execution parameters
 * @param params.taskId - The task identifier
 * @param params.tool - The tool to execute
 * @param params.args - Tool arguments
 * @param params.apifyToken - Apify API token
 * @param params.progressToken - Progress token for notifications
 * @param params.extra - Extra request handler context
 * @param params.mcpSessionId - MCP session ID for telemetry
 */
async function executeToolAndUpdateTask(params: ExecuteToolAndUpdateTaskParams): Promise<void> {
    const {
        taskId,
        tool,
        args,
        apifyToken,
        progressToken,
        extra,
        mcpSessionId,
        userRentedActorIds,
        taskStore,
        server,
        apifyMcpServer,
        prepareTelemetryData,
        finalizeAndTrackTelemetry,
    } = params;
    let toolStatus: ToolStatus = TOOL_STATUS.SUCCEEDED;
    const startTime = Date.now();

    log.debug('[executeToolAndUpdateTask] Starting task execution', {
        taskId,
        toolName: tool.name,
        mcpSessionId,
    });

    // Prepare telemetry before try-catch so it's accessible to both paths.
    // This avoids re-fetching user data in the error handler.
    const { telemetryData, userId } = await prepareTelemetryData(tool, mcpSessionId, apifyToken);

    try {
        // Check if task was already cancelled before we start execution.
        // Critical: if a client cancels the task immediately after creation (race condition),
        // attempting to transition from 'cancelled' (terminal state) to 'working' will fail in the SDK
        // because terminal states cannot transition to other states. We must check before calling updateTaskStatus.
        if (await isTaskCancelled(taskId, mcpSessionId, taskStore)) {
            log.debug('[executeToolAndUpdateTask] Task was cancelled before execution started, skipping', {
                taskId,
                mcpSessionId,
            });
            finalizeAndTrackTelemetry(telemetryData, userId, startTime, TOOL_STATUS.ABORTED);
            return;
        }

        log.debug('[executeToolAndUpdateTask] Updating task status to working', {
            taskId,
            mcpSessionId,
        });
        await taskStore.updateTaskStatus(taskId, 'working', undefined, mcpSessionId);

        const taskToolExecutionResult = await executeToolForTask({
            tool,
            args,
            apifyToken,
            progressToken,
            extra,
            mcpSessionId,
            userRentedActorIds,
            apifyMcpServer,
            mcpServer: server,
            taskId,
        });

        const { response: result } = taskToolExecutionResult;
        toolStatus = taskToolExecutionResult.toolStatus;

        // Check if task was cancelled before storing result
        if (await isTaskCancelled(taskId, mcpSessionId, taskStore)) {
            log.debug('[executeToolAndUpdateTask] Task was cancelled, skipping result storage', {
                taskId,
                mcpSessionId,
            });
            finalizeAndTrackTelemetry(telemetryData, userId, startTime, toolStatus);
            return;
        }

        // Store the result in the task store
        log.debug('[executeToolAndUpdateTask] Storing completed result', {
            taskId,
            mcpSessionId,
        });
        await taskStore.storeTaskResult(taskId, 'completed', result, mcpSessionId);
        log.debug('Task completed successfully', { taskId, toolName: tool.name, mcpSessionId });

        finalizeAndTrackTelemetry(telemetryData, userId, startTime, toolStatus);
    } catch (error) {
        log.error('Error executing tool for task', { taskId, mcpSessionId, error });
        toolStatus = getToolStatusFromError(error, Boolean(extra.signal?.aborted));
        const errorMessage = (error instanceof Error) ? error.message : 'Unknown error';

        // Check if task was cancelled before storing result
        // TODO: In future, we should actually stop execution via AbortController,
        // but coordinating cancellation across distributed nodes would be complex
        if (await isTaskCancelled(taskId, mcpSessionId, taskStore)) {
            log.debug('[executeToolAndUpdateTask] Task was cancelled, skipping result storage', {
                taskId,
                mcpSessionId,
            });
            finalizeAndTrackTelemetry(telemetryData, userId, startTime, toolStatus);
            return;
        }

        log.debug('[executeToolAndUpdateTask] Storing failed result', {
            taskId,
            mcpSessionId,
            error: errorMessage,
        });
        await taskStore.storeTaskResult(taskId, 'failed', {
            content: [{
                type: 'text' as const,
                text: `Error calling tool: ${errorMessage}. Please verify the tool name, input parameters, and ensure all required resources are available.`,
            }],
            isError: true,
            internalToolStatus: toolStatus,
        }, mcpSessionId);

        finalizeAndTrackTelemetry(telemetryData, userId, startTime, toolStatus);
    }
}
