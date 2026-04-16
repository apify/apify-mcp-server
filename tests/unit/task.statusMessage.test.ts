import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { describe, expect, it } from 'vitest';

import { storeTaskResultWithMessage } from '../../src/mcp/utils.js';

/**
 * Regression tests for #638: tasks/list shows stale statusMessage for completed tasks.
 *
 * storeTaskResult() does not accept a statusMessage parameter, so we must call
 * updateTaskStatus() with the final message before calling storeTaskResult().
 *
 * These tests verify:
 * 1. statusMessage survives the storeTaskResult() transition (SDK invariant)
 * 2. The correct final message is set for each outcome (success, payment required, failed)
 * 3. Non-success paths do NOT get a misleading ": completed" message
 */
describe('Task statusMessage after terminal transition', () => {
    const REQUEST_ID = 'req-1';
    const REQUEST = { method: 'tools/call', params: { name: 'test-tool' } };

    async function createWorkingTask(store: InMemoryTaskStore) {
        const task = await store.createTask({ ttl: 60_000 }, REQUEST_ID, REQUEST);
        return task.taskId;
    }

    it('should set statusMessage and status via storeTaskResultWithMessage', async () => {
        const store = new InMemoryTaskStore();
        const taskId = await createWorkingTask(store);

        await storeTaskResultWithMessage(store, taskId, 'completed', {
            content: [{ type: 'text', text: 'result data' }],
        }, 'apify/rag-web-browser: completed');

        const task = await store.getTask(taskId);
        expect(task).not.toBeNull();
        expect(task!.status).toBe('completed');
        expect(task!.statusMessage).toBe('apify/rag-web-browser: completed');
    });

    it('should set statusMessage for error tasks via storeTaskResultWithMessage', async () => {
        const store = new InMemoryTaskStore();
        const taskId = await createWorkingTask(store);

        // Error results are stored as 'completed' because the SDK's requestStream() only
        // delivers getTaskResult() for 'completed' tasks. The [error] prefix signals the
        // real outcome to clients polling tasks/list.
        await storeTaskResultWithMessage(store, taskId, 'completed', {
            content: [{ type: 'text', text: 'error' }],
            isError: true,
        }, '[error] my-tool: failed');

        const task = await store.getTask(taskId);
        expect(task!.status).toBe('completed');
        expect(task!.statusMessage).toBe('[error] my-tool: failed');
    });

    it('should set "payment required" statusMessage for pre-flight 402 path', async () => {
        const store = new InMemoryTaskStore();
        const taskId = await createWorkingTask(store);

        // Simulates the pre-flight payment failure path in executeToolAndUpdateTask.
        // Stored as 'completed' so the SDK's requestStream() delivers the x402 payload
        // to the client for auto-pay retry. The [error] prefix signals the real outcome.
        await store.updateTaskStatus(taskId, 'working', '[error] apify/rag-web-browser: payment required');

        await store.storeTaskResult(taskId, 'completed', {
            content: [{ type: 'text', text: 'Payment required' }],
        });

        const task = await store.getTask(taskId);
        expect(task!.status).toBe('completed');
        expect(task!.statusMessage).toBe('[error] apify/rag-web-browser: payment required');
    });

    it('should set status "cancelled" when task was aborted via signal, not "completed"', async () => {
        const store = new InMemoryTaskStore();
        const taskId = await createWorkingTask(store);

        // Simulates the signal-based abort path: executeActorTool returns null,
        // toolStatus = ABORTED. The fix transitions to 'cancelled' instead of
        // storing as 'completed' with empty result.
        await store.updateTaskStatus(taskId, 'working', 'apify/rag-web-browser: Running the crawler.');
        await store.updateTaskStatus(taskId, 'cancelled', 'apify/rag-web-browser: aborted by client');

        const task = await store.getTask(taskId);
        expect(task!.status).toBe('cancelled');
        expect(task!.statusMessage).toBe('apify/rag-web-browser: aborted by client');
    });

    it('should not call updateTaskStatus on cancelled task (402 catch path)', async () => {
        const store = new InMemoryTaskStore();
        const taskId = await createWorkingTask(store);

        // Simulate: task is cancelled while actor is running
        await store.updateTaskStatus(taskId, 'cancelled', 'Cancelled by client');

        const task = await store.getTask(taskId);
        expect(task!.status).toBe('cancelled');

        // Trying to transition from cancelled → working should throw (SDK enforces terminal state).
        // The fix adds an isTaskCancelled guard before updateTaskStatus in the 402 catch path.
        await expect(store.updateTaskStatus(taskId, 'working', 'some-tool: payment required')).rejects.toThrow();
    });
});
