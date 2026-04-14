import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { describe, expect, it } from 'vitest';

/**
 * Regression tests for #638: tasks/list shows stale statusMessage for completed tasks.
 *
 * storeTaskResult() does not accept a statusMessage parameter, so we must call
 * updateTaskStatus() with the final message before calling storeTaskResult().
 * These tests verify that statusMessage survives the storeTaskResult() transition.
 */
describe('Task statusMessage after terminal transition', () => {
    const REQUEST_ID = 'req-1';
    const REQUEST = { method: 'tools/call', params: { name: 'test-tool' } };

    async function createWorkingTask(store: InMemoryTaskStore) {
        const task = await store.createTask({ ttl: 60_000 }, REQUEST_ID, REQUEST);
        return task.taskId;
    }

    it('should retain final statusMessage after storeTaskResult completes the task', async () => {
        const store = new InMemoryTaskStore();
        const taskId = await createWorkingTask(store);

        // Intermediate progress message (as set by ProgressTracker during execution)
        await store.updateTaskStatus(taskId, 'working', 'apify/rag-web-browser: Starting the crawler.');

        // Final message set just before storeTaskResult (the fix)
        await store.updateTaskStatus(taskId, 'working', 'apify/rag-web-browser: completed');

        await store.storeTaskResult(taskId, 'completed', {
            content: [{ type: 'text', text: 'result data' }],
        });

        const task = await store.getTask(taskId);
        expect(task).not.toBeNull();
        expect(task!.status).toBe('completed');
        expect(task!.statusMessage).toBe('apify/rag-web-browser: completed');
    });

    it('should retain final statusMessage after storeTaskResult marks task as failed', async () => {
        const store = new InMemoryTaskStore();
        const taskId = await createWorkingTask(store);

        await store.updateTaskStatus(taskId, 'working', 'my-tool: failed');

        await store.storeTaskResult(taskId, 'failed', {
            content: [{ type: 'text', text: 'error' }],
            isError: true,
        });

        const task = await store.getTask(taskId);
        expect(task!.status).toBe('failed');
        expect(task!.statusMessage).toBe('my-tool: failed');
    });

    it('should show stale statusMessage when final updateTaskStatus is skipped (documents the bug)', async () => {
        const store = new InMemoryTaskStore();
        const taskId = await createWorkingTask(store);

        await store.updateTaskStatus(taskId, 'working', 'Starting the crawler.');

        // No final updateTaskStatus — this is the buggy path
        await store.storeTaskResult(taskId, 'completed', {
            content: [{ type: 'text', text: 'result data' }],
        });

        const task = await store.getTask(taskId);
        expect(task!.status).toBe('completed');
        // statusMessage is stale — still the intermediate progress message
        expect(task!.statusMessage).toBe('Starting the crawler.');
    });
});
