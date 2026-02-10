import type { TaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/interfaces.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
    CancelTaskRequestSchema,
    ErrorCode,
    GetTaskPayloadRequestSchema,
    GetTaskRequestSchema,
    ListTasksRequestSchema,
    McpError,
} from '@modelcontextprotocol/sdk/types.js';

import log from '@apify/log';

import type { ApifyRequestParams } from '../types.js';

type RegisterTaskHandlersParams = {
    server: Server;
    taskStore: TaskStore;
};

/**
 * Registers long-running task request handlers.
 */
export function registerTaskHandlers({ server, taskStore }: RegisterTaskHandlersParams): void {
    // List tasks
    server.setRequestHandler(ListTasksRequestSchema, async (request) => {
        // mcpSessionId is injected at transport layer for session isolation in task stores
        const params = (request.params || {}) as ApifyRequestParams & { cursor?: string };
        const { cursor } = params;
        const mcpSessionId = params._meta?.mcpSessionId;
        log.debug('[ListTasksRequestSchema] Listing tasks', { mcpSessionId });
        const result = await taskStore.listTasks(cursor, mcpSessionId);
        return { tasks: result.tasks, nextCursor: result.nextCursor };
    });

    // Get task status
    server.setRequestHandler(GetTaskRequestSchema, async (request) => {
        // mcpSessionId is injected at transport layer for session isolation in task stores
        const params = (request.params || {}) as ApifyRequestParams & { taskId: string };
        const { taskId } = params;
        const mcpSessionId = params._meta?.mcpSessionId;
        log.debug('[GetTaskRequestSchema] Getting task status', { taskId, mcpSessionId });
        const task = await taskStore.getTask(taskId, mcpSessionId);
        if (task) return task;

        // logging as this may not be just a soft fail but related to issue with the task store
        log.error('[GetTaskRequestSchema] Task not found', { taskId, mcpSessionId });
        throw new McpError(ErrorCode.InvalidParams, `Task "${taskId}" not found`);
    });

    // Get task result payload
    server.setRequestHandler(GetTaskPayloadRequestSchema, async (request) => {
        // mcpSessionId is injected at transport layer for session isolation in task stores
        const params = (request.params || {}) as ApifyRequestParams & { taskId: string };
        const { taskId } = params;
        const mcpSessionId = params._meta?.mcpSessionId;
        log.debug('[GetTaskPayloadRequestSchema] Getting task result', { taskId, mcpSessionId });
        const task = await taskStore.getTask(taskId, mcpSessionId);
        if (!task) {
            // logging as this may not be just a soft fail but related to issue with the task store
            log.error('[GetTaskPayloadRequestSchema] Task not found', { taskId, mcpSessionId });
            throw new McpError(
                ErrorCode.InvalidParams,
                `Task "${taskId}" not found`,
            );
        }
        if (task.status !== 'completed' && task.status !== 'failed') {
            throw new McpError(
                ErrorCode.InvalidParams,
                `Task "${taskId}" is not completed yet. Current status: ${task.status}`,
            );
        }
        return await taskStore.getTaskResult(taskId, mcpSessionId);
    });

    // Cancel task
    server.setRequestHandler(CancelTaskRequestSchema, async (request) => {
        // mcpSessionId is injected at transport layer for session isolation in task stores
        const params = (request.params || {}) as ApifyRequestParams & { taskId: string };
        const { taskId } = params;
        const mcpSessionId = params._meta?.mcpSessionId;
        log.debug('[CancelTaskRequestSchema] Cancelling task', { taskId, mcpSessionId });

        const task = await taskStore.getTask(taskId, mcpSessionId);
        if (!task) {
            // logging as this may not be just a soft fail but related to issue with the task store
            log.error('[CancelTaskRequestSchema] Task not found', { taskId, mcpSessionId });
            throw new McpError(
                ErrorCode.InvalidParams,
                `Task "${taskId}" not found`,
            );
        }
        if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
            log.error('[CancelTaskRequestSchema] Task already in terminal state', {
                taskId,
                mcpSessionId,
                status: task.status,
            });
            throw new McpError(
                ErrorCode.InvalidParams,
                `Cannot cancel task "${taskId}" with status "${task.status}"`,
            );
        }
        await taskStore.updateTaskStatus(taskId, 'cancelled', 'Cancelled by client', mcpSessionId);
        const updatedTask = await taskStore.getTask(taskId, mcpSessionId);
        log.debug('[CancelTaskRequestSchema] Task cancelled successfully', { taskId, mcpSessionId });
        return updatedTask!;
    });
}
