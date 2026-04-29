import type { Request } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';

import { ApifyInMemoryTaskStore } from '../../src/mcp/task_store.js';

const fakeRequest: Request = {
    method: 'tools/call',
    params: { name: 'apify-slash-rag-web-browser', arguments: {} },
};

describe('ApifyInMemoryTaskStore', () => {
    it('uses requestId as the taskId (matches RedisTaskStore semantics)', async () => {
        const store = new ApifyInMemoryTaskStore();
        const desiredId = 'apify--rag-web-browser-x7kQ9mZpA1bC';

        const task = await store.createTask({ ttl: 60_000 }, desiredId, fakeRequest);

        expect(task.taskId).toBe(desiredId);

        // Round-trip: the task is retrievable under the chosen id.
        const fetched = await store.getTask(desiredId);
        expect(fetched).not.toBeNull();
        expect(fetched?.taskId).toBe(desiredId);
        expect(fetched?.status).toBe('working');

        // ListTasks surfaces the same id.
        const { tasks } = await store.listTasks();
        expect(tasks.map((t) => t.taskId)).toEqual([desiredId]);

        store.cleanup();
    });

    it('rejects empty requestId', async () => {
        const store = new ApifyInMemoryTaskStore();
        await expect(store.createTask({ ttl: null }, '', fakeRequest)).rejects.toThrow(/non-empty/);
        store.cleanup();
    });

    it('rejects duplicate taskIds without leaving rolled-back entries behind', async () => {
        const store = new ApifyInMemoryTaskStore();
        await store.createTask({ ttl: 60_000 }, 'dup-id-aaaaaaaaaaaa', fakeRequest);
        await expect(store.createTask({ ttl: 60_000 }, 'dup-id-aaaaaaaaaaaa', fakeRequest))
            .rejects.toThrow(/already exists/);

        const { tasks } = await store.listTasks();
        expect(tasks).toHaveLength(1);
        store.cleanup();
    });

    it('honors TTL cleanup after rekeying', async () => {
        const store = new ApifyInMemoryTaskStore();
        const id = 'ttl-test-aaaaaaaaaaaa';
        await store.createTask({ ttl: 10 }, id, fakeRequest);

        await new Promise((resolve) => { setTimeout(resolve, 50); });

        const fetched = await store.getTask(id);
        expect(fetched).toBeNull();
        store.cleanup();
    });
});
