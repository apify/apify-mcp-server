import type { CreateTaskOptions } from '@modelcontextprotocol/sdk/experimental/tasks/interfaces.js';
import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import type { Request, RequestId, Task } from '@modelcontextprotocol/sdk/types.js';

/**
 * In-memory task store that uses the `requestId` argument as the task ID,
 * matching the contract of `RedisTaskStore` in `apify-mcp-server-internal`
 * (which does `String(requestId)`).
 *
 * The SDK's `InMemoryTaskStore.createTask` ignores `requestId` and generates
 * its own 32-char hex ID via a private `generateTaskId` method. That divergence
 * meant the same call site produced different task ID formats on stdio and on
 * hosted HTTP/SSE — and is what made #725 (request-id only) and #743 (private
 * method override only) each fix one path while breaking the other.
 *
 * Aligning both stores on `requestId` lets `server.ts` generate the short,
 * tool-prefixed ID once and have it surface unchanged on every transport.
 *
 * Implementation note: we override `createTask` rather than reusing super.
 * Calling super and rekeying after the fact does not work, because the SDK's
 * TTL setTimeout closes over the SDK-generated ID — once we move the entry to
 * a new key, the timer's `tasks.delete` no longer matches and the task leaks.
 * `getTask`, `storeTaskResult`, `updateTaskStatus`, `getTaskResult`,
 * `listTasks`, and `cleanup` are inherited unchanged — they all read from
 * `this.tasks` keyed by whatever ID we wrote, so they Just Work.
 */
type Internal = {
    tasks: Map<string, { task: Task; request: Request; requestId: RequestId; result?: unknown }>;
    cleanupTimers: Map<string, ReturnType<typeof setTimeout>>;
};

export class ApifyInMemoryTaskStore extends InMemoryTaskStore {
    override async createTask(
        taskParams: CreateTaskOptions,
        requestId: RequestId,
        _request: Request,
        _sessionId?: string,
    ): Promise<Task> {
        const taskId = String(requestId);
        if (!taskId) {
            throw new Error('ApifyInMemoryTaskStore.createTask: requestId must be a non-empty string');
        }
        const internal = this as unknown as Internal;
        if (internal.tasks.has(taskId)) {
            throw new Error(`Task with ID ${taskId} already exists`);
        }
        const actualTtl = taskParams.ttl ?? null;
        const createdAt = new Date().toISOString();
        const task: Task = {
            taskId,
            status: 'working',
            ttl: actualTtl,
            createdAt,
            lastUpdatedAt: createdAt,
            pollInterval: taskParams.pollInterval ?? 1000,
        };
        internal.tasks.set(taskId, { task, request: _request, requestId });
        if (actualTtl) {
            const timer = setTimeout(() => {
                internal.tasks.delete(taskId);
                internal.cleanupTimers.delete(taskId);
            }, actualTtl);
            internal.cleanupTimers.set(taskId, timer);
        }
        return task;
    }
}
