import type { CreateTaskOptions } from '@modelcontextprotocol/sdk/experimental/tasks/interfaces.js';
import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import type { Request, RequestId, Task } from '@modelcontextprotocol/sdk/types.js';

/**
 * Uses `requestId` as the task ID. We override (rather than call super and rekey) because
 * the inherited TTL `setTimeout` closes over the SDK-generated ID — rekeying after the fact
 * would leave the timer pointing at a stale key, leaking the task on TTL expiry.
 */
type Internal = {
    tasks: Map<string, { task: Task; request: Request; requestId: RequestId; result?: unknown }>;
    cleanupTimers: Map<string, ReturnType<typeof setTimeout>>;
};

export class ApifyInMemoryTaskStore extends InMemoryTaskStore {
    override async createTask(
        taskParams: CreateTaskOptions,
        requestId: RequestId,
        request: Request,
    ): Promise<Task> {
        const taskId = String(requestId);
        if (!taskId) {
            throw new Error('requestId must be a non-empty string');
        }
        const internal = this as unknown as Internal;
        if (internal.tasks.has(taskId)) {
            throw new Error(`Task with ID ${taskId} already exists`);
        }
        const ttl = taskParams.ttl ?? null;
        const createdAt = new Date().toISOString();
        const task: Task = {
            taskId,
            status: 'working',
            ttl,
            createdAt,
            lastUpdatedAt: createdAt,
            pollInterval: taskParams.pollInterval ?? 1000,
        };
        internal.tasks.set(taskId, { task, request, requestId });
        if (ttl) {
            const timer = setTimeout(() => {
                internal.tasks.delete(taskId);
                internal.cleanupTimers.delete(taskId);
            }, ttl);
            internal.cleanupTimers.set(taskId, timer);
        }
        return task;
    }
}
