import type { InternalToolArgs } from '../../../src/types.js';

/** A task API document with internal fields that the task tools must not leak. */
export function mockTask(overrides: Record<string, unknown> = {}) {
    return {
        id: 'task-1',
        actId: 'actor-id-1',
        userId: 'user-secret',
        name: 'my-task',
        title: 'My task',
        description: 'Does a thing',
        input: { query: 'cats', apiKey: 'secret-input-value' },
        publicConfig: { publishedAt: '2026-08-01T10:00:00.000Z', seoTitle: 'Seo title', datasetView: 'overview' },
        ...overrides,
    };
}

/** A recorded resource-client method call. */
export type RecordedCall = { fn: string; taskId?: string; payload?: unknown };

/**
 * Fake ApifyClient covering everything the task tools use: `task().get/update/publish/unpublish()`
 * and `tasks().create()`. Every call is recorded into `calls` so tests can assert which method ran
 * and with what payload. `publish`/`unpublish` are the client's own wrappers around an update that
 * sets the virtual `isPublic` field — keeping that payload right is the client's contract, so the
 * tools are only checked for calling the right method.
 */
export function mockTaskApiClient(task: unknown): {
    apifyClient: InternalToolArgs['apifyClient'];
    calls: RecordedCall[];
} {
    const calls: RecordedCall[] = [];
    const apifyClient = {
        // `taskId` is recorded because the tools normalize a bare task name to `~name` before the
        // call — the API would otherwise read the name as an ID and 404.
        task: (taskId: string) => ({
            get: async () => {
                calls.push({ fn: 'get', taskId });
                return task;
            },
            update: async (payload: unknown) => {
                calls.push({ fn: 'update', taskId, payload });
                return task;
            },
            publish: async () => {
                calls.push({ fn: 'publish', taskId });
                return task;
            },
            unpublish: async () => {
                calls.push({ fn: 'unpublish', taskId });
                return task;
            },
        }),
        tasks: () => ({
            create: async (payload: unknown) => {
                calls.push({ fn: 'create', payload });
                return task;
            },
        }),
    } as unknown as InternalToolArgs['apifyClient'];
    return { apifyClient, calls };
}
