import type { CreateTaskOptions } from '@modelcontextprotocol/sdk/experimental/tasks/interfaces.js';
import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import type { Request, RequestId, Task } from '@modelcontextprotocol/sdk/types.js';

/**
 * Extends InMemoryTaskStore to support custom task IDs via context.taskId.
 *
 * Pass context: { taskId: '<desired-id>' } in CreateTaskOptions to override the
 * auto-generated ID. InMemoryTaskStore.generateTaskId() is private and called
 * synchronously inside createTask, so we shadow it on the instance for one call.
 */
export class ApifyTaskStore extends InMemoryTaskStore {
    override async createTask(
        taskParams: CreateTaskOptions,
        requestId: RequestId,
        request: Request,
        sessionId?: string,
    ): Promise<Task> {
        const customId = taskParams.context?.taskId;
        if (typeof customId === 'string' && customId) {
            (this as unknown as { generateTaskId: () => string }).generateTaskId = () => {
                delete (this as unknown as { generateTaskId?: () => string }).generateTaskId;
                return customId;
            };
        }
        return super.createTask(taskParams, requestId, request, sessionId);
    }
}
