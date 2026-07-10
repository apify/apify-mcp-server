import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { RELATED_TASK_META_KEY } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';

import { emitTaskStatusNotification } from '../../src/mcp/server.js';
import { getRequestHandler, withServer } from './helpers/mcp_server.js';

// Helper to create a minimal TaskStore mock
function makeTaskStore(task: Record<string, unknown> | undefined) {
    return {
        getTask: vi.fn().mockResolvedValue(task),
        updateTaskStatus: vi.fn().mockResolvedValue(undefined),
    };
}

function makeServer() {
    return { notification: vi.fn().mockResolvedValue(undefined) } as unknown as Server;
}

describe('emitTaskStatusNotification', () => {
    it('sends notifications/tasks/status with full Task shape', async () => {
        const server = makeServer();
        const task = {
            taskId: 'task-1',
            status: 'working',
            createdAt: '2025-01-01T00:00:00.000Z',
            lastUpdatedAt: '2025-01-01T00:00:01.000Z',
            ttl: 3600,
            statusMessage: 'Crawling page 1',
        };
        const store = makeTaskStore(task);

        await emitTaskStatusNotification('task-1', undefined, store as never, server);

        expect(server.notification).toHaveBeenCalledOnce();
        const notification = (server.notification as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(notification.method).toBe('notifications/tasks/status');
        expect(notification.params).toMatchObject({
            taskId: 'task-1',
            status: 'working',
            createdAt: '2025-01-01T00:00:00.000Z',
            lastUpdatedAt: '2025-01-01T00:00:01.000Z',
            ttl: 3600,
            statusMessage: 'Crawling page 1',
        });
    });

    it('does NOT include _meta.related-task in notification (SHOULD NOT)', async () => {
        const server = makeServer();
        const task = {
            taskId: 'task-1',
            status: 'working',
            createdAt: '2025-01-01T00:00:00.000Z',
            lastUpdatedAt: '2025-01-01T00:00:01.000Z',
            ttl: 3600,
        };
        const store = makeTaskStore(task);

        await emitTaskStatusNotification('task-1', undefined, store as never, server);

        const notification = (server.notification as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(notification).not.toHaveProperty('_meta');
        expect(notification.params).not.toHaveProperty('_meta');
        expect((notification.params as Record<string, unknown>)?.[RELATED_TASK_META_KEY]).toBeUndefined();
    });

    it('omits statusMessage when null', async () => {
        const server = makeServer();
        const store = makeTaskStore({
            taskId: 'task-1',
            status: 'working',
            createdAt: '2025-01-01T00:00:00.000Z',
            lastUpdatedAt: '2025-01-01T00:00:01.000Z',
            ttl: 3600,
            statusMessage: null,
        });

        await emitTaskStatusNotification('task-1', undefined, store as never, server);

        const params = (server.notification as ReturnType<typeof vi.fn>).mock.calls[0][0].params as Record<
            string,
            unknown
        >;
        expect(params).not.toHaveProperty('statusMessage');
    });

    it('is silent when task is not found', async () => {
        const server = makeServer();
        const store = makeTaskStore(undefined);

        await emitTaskStatusNotification('missing', undefined, store as never, server);

        expect(server.notification).not.toHaveBeenCalled();
    });

    it('is silent when server.notification throws', async () => {
        const server = { notification: vi.fn().mockRejectedValue(new Error('transport closed')) } as unknown as Server;
        const store = makeTaskStore({
            taskId: 'task-1',
            status: 'working',
            createdAt: '2025-01-01T00:00:00.000Z',
            lastUpdatedAt: '2025-01-01T00:00:01.000Z',
            ttl: 3600,
        });

        // Should not throw
        await expect(emitTaskStatusNotification('task-1', undefined, store as never, server)).resolves.toBeUndefined();
    });
});

describe('tasks/result _meta.related-task injection', () => {
    // Minimal fake CallToolRequest required by InMemoryTaskStore.createTask
    const fakeRequest = { method: 'tools/call', params: { name: 'test-tool', arguments: {} } };

    it('injects _meta.related-task into tasks/result response (MUST)', async () => {
        await withServer(async (server) => {
            const task = await server.taskStore.createTask({ ttl: 60_000 }, 'req-1', fakeRequest as never);
            await server.taskStore.storeTaskResult(
                task.taskId,
                'completed',
                { content: [{ type: 'text', text: 'done' }] },
                undefined,
            );

            const handler = getRequestHandler(server, 'tasks/result');
            const result = await handler(
                { method: 'tasks/result', params: { taskId: task.taskId } },
                { sendNotification: vi.fn() },
            );

            expect((result as Record<string, unknown>)._meta).toMatchObject({
                [RELATED_TASK_META_KEY]: { taskId: task.taskId },
            });
        });
    });

    it('merges _meta.related-task with existing _meta keys', async () => {
        await withServer(async (server) => {
            const task = await server.taskStore.createTask({ ttl: 60_000 }, 'req-2', fakeRequest as never);
            const existingMeta = { 'com.apify/ActorRun': { runId: 'run-abc' } };
            await server.taskStore.storeTaskResult(
                task.taskId,
                'completed',
                {
                    content: [{ type: 'text', text: 'done' }],
                    _meta: existingMeta,
                },
                undefined,
            );

            const handler = getRequestHandler(server, 'tasks/result');
            const result = (await handler(
                { method: 'tasks/result', params: { taskId: task.taskId } },
                { sendNotification: vi.fn() },
            )) as Record<string, unknown>;

            const meta = result._meta as Record<string, unknown>;
            expect(meta[RELATED_TASK_META_KEY]).toEqual({ taskId: task.taskId });
            expect(meta['com.apify/ActorRun']).toEqual({ runId: 'run-abc' });
        });
    });
});
