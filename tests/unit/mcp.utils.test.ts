import type { TaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/interfaces.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import log from '@apify/log';

import {
    createTaskCancellationWatcher,
    isTaskCancelled,
    isTaskNotFoundError,
    parseInputParamsFromUrl,
    storeTaskResultOrSkipIfExpired,
} from '../../src/mcp/utils.js';

describe('parseInputParamsFromUrl()', () => {
    it('handles URL without query params', () => {
        const url = 'https://mcp.apify.com';
        const result = parseInputParamsFromUrl(url);
        expect(result.actors).toBeUndefined();
    });

    it('parses Actors from URL query params as tools', () => {
        const url = 'https://mcp.apify.com?token=123&actors=apify/web-scraper';
        const result = parseInputParamsFromUrl(url);
        expect(result.tools).toEqual(['apify/web-scraper']);
        expect(result.actors).toBeUndefined();
    });

    it('parses multiple Actors from URL as tools', () => {
        const url = 'https://mcp.apify.com?actors=apify/instagram-scraper,lukaskrivka/google-maps';
        const result = parseInputParamsFromUrl(url);
        expect(result.tools).toEqual(['apify/instagram-scraper', 'lukaskrivka/google-maps']);
        expect(result.actors).toBeUndefined();
    });

    it('handles Actors as string parameter as tools', () => {
        const url = 'https://mcp.apify.com?actors=apify/rag-web-browser';
        const result = parseInputParamsFromUrl(url);
        expect(result.tools).toEqual(['apify/rag-web-browser']);
        expect(result.actors).toBeUndefined();
    });

    it('parses the deprecated enableActorAutoLoading flag as enableAddingActors', () => {
        const url = 'https://mcp.apify.com?enableActorAutoLoading=true';
        const result = parseInputParamsFromUrl(url);
        expect(result.enableAddingActors).toBe(true);
    });

    it('parses enableAddingActors=true', () => {
        const url = 'https://mcp.apify.com?enableAddingActors=true';
        const result = parseInputParamsFromUrl(url);
        expect(result.enableAddingActors).toBe(true);
    });

    it('parses enableAddingActors=false', () => {
        const url = 'https://mcp.apify.com?enableAddingActors=false';
        const result = parseInputParamsFromUrl(url);
        expect(result.enableAddingActors).toBe(false);
    });
});

describe('isTaskCancelled()', () => {
    const makeTaskStore = (getTaskReturn: unknown) =>
        ({
            getTask: vi.fn().mockResolvedValue(getTaskReturn),
        }) as unknown as TaskStore;

    it('returns true when task status is cancelled', async () => {
        const taskStore = makeTaskStore({ status: 'cancelled' });
        const result = await isTaskCancelled('task-1', 'session-1', taskStore);

        expect(result).toBe(true);
    });

    it('returns false when task status is not cancelled', async () => {
        const taskStore = makeTaskStore({ status: 'working' });
        const result = await isTaskCancelled('task-1', 'session-1', taskStore);

        expect(result).toBe(false);
    });

    it('returns false when task is not found (getTask returns undefined)', async () => {
        const taskStore = makeTaskStore(undefined);
        const result = await isTaskCancelled('task-1', 'session-1', taskStore);

        expect(result).toBe(false);
    });

    it('passes taskId and mcpSessionId through to taskStore.getTask', async () => {
        const taskStore = makeTaskStore({ status: 'working' });
        await isTaskCancelled('task-42', 'session-xyz', taskStore);

        expect(taskStore.getTask).toHaveBeenCalledWith('task-42', 'session-xyz');
    });
});

describe('isTaskNotFoundError()', () => {
    it('matches the in-memory and Redis store messages', () => {
        expect(isTaskNotFoundError(new Error('Task with ID call-tool-x not found'))).toBe(true);
        expect(isTaskNotFoundError(new Error('Task with ID call-tool-x not found or expired'))).toBe(true);
    });

    it('returns false for unrelated errors and non-Error values', () => {
        expect(isTaskNotFoundError(new Error('Cannot store result for task x in terminal status'))).toBe(false);
        expect(isTaskNotFoundError('Task with ID x not found')).toBe(false);
    });
});

describe('storeTaskResultOrSkipIfExpired()', () => {
    afterEach(() => vi.restoreAllMocks());

    const makeStore = (impl: () => Promise<void>) => ({ storeTaskResult: vi.fn(impl) }) as unknown as TaskStore;

    it('stores the result when the task is present', async () => {
        const store = makeStore(async () => {});
        const softFail = vi.spyOn(log, 'softFail').mockImplementation(() => log);

        await storeTaskResultOrSkipIfExpired(store, 'call-actor', 'task-1', 'completed', { content: [] }, 'sess-1');

        expect(store.storeTaskResult).toHaveBeenCalledWith('task-1', 'completed', { content: [] }, 'sess-1');
        expect(softFail).not.toHaveBeenCalled();
    });

    it('soft-fails without throwing when the task expired', async () => {
        const store = makeStore(async () => {
            throw new Error('Task with ID task-1 not found or expired');
        });
        const softFail = vi.spyOn(log, 'softFail').mockImplementation(() => log);

        await expect(
            storeTaskResultOrSkipIfExpired(store, 'call-actor', 'task-1', 'failed', { content: [] }, 'sess-1'),
        ).resolves.toBeUndefined();
        expect(softFail).toHaveBeenCalledOnce();
    });

    it('rethrows non-expiry errors', async () => {
        const store = makeStore(async () => {
            throw new Error('redis ETIMEDOUT');
        });

        await expect(
            storeTaskResultOrSkipIfExpired(store, 'call-actor', 'task-1', 'failed', { content: [] }, 'sess-1'),
        ).rejects.toThrow('redis ETIMEDOUT');
    });
});

describe('createTaskCancellationWatcher', () => {
    const makeTaskStore = (statusBox: { status: string }) =>
        ({
            getTask: vi.fn().mockImplementation(async () => ({ status: statusBox.status })),
        }) as unknown as TaskStore;

    // Core happy path: tasks/cancel writes 'cancelled' to the store; the
    // watcher must observe it on the next poll and abort the signal.
    it('aborts the derived signal once the task store reports cancelled', async () => {
        const statusBox = { status: 'working' };
        const taskStore = makeTaskStore(statusBox);

        const watcher = createTaskCancellationWatcher({
            taskId: 't1',
            mcpSessionId: 's1',
            taskStore,
            pollIntervalMs: 20,
        });

        try {
            expect(watcher.signal.aborted).toBe(false);
            statusBox.status = 'cancelled';
            await vi.waitFor(
                () => {
                    expect(watcher.signal.aborted).toBe(true);
                },
                { timeout: 500, interval: 10 },
            );
        } finally {
            watcher.dispose();
        }
    });

    // Spec contract: per MCP tasks spec, a task's lifetime is decoupled
    // from the original request. Client disconnect, transport close, or
    // `notifications/cancelled` for the original request ID MUST NOT
    // cancel the task — only `tasks/cancel` (which writes to the store)
    // is allowed to. A regression here would silently kill long-running
    // Actor runs whenever a flaky client briefly disconnects.
    it('does not abort when an unrelated AbortSignal fires (task survives client disconnect)', async () => {
        const statusBox = { status: 'working' };
        const taskStore = makeTaskStore(statusBox);
        // This signal models `extra.signal` from the original request:
        // it MUST NOT be observable by the watcher.
        const requestSignal = new AbortController();

        const watcher = createTaskCancellationWatcher({
            taskId: 't1',
            mcpSessionId: 's1',
            taskStore,
            pollIntervalMs: 10,
        });

        try {
            requestSignal.abort(new Error('client disconnect'));
            // Give the watcher more than enough ticks to (incorrectly) react.
            await new Promise((resolve) => {
                setTimeout(resolve, 80);
            });
            expect(watcher.signal.aborted).toBe(false);
        } finally {
            watcher.dispose();
        }
    });

    // setInterval keeps firing for the lifetime of the process; without
    // dispose() the watcher leaks for every completed task.
    it('dispose stops polling the task store', async () => {
        const statusBox = { status: 'working' };
        const taskStore = makeTaskStore(statusBox);

        const watcher = createTaskCancellationWatcher({
            taskId: 't1',
            mcpSessionId: 's1',
            taskStore,
            pollIntervalMs: 10,
        });

        await new Promise((resolve) => {
            setTimeout(resolve, 30);
        });
        watcher.dispose();
        const callsAtDispose = (taskStore.getTask as ReturnType<typeof vi.fn>).mock.calls.length;
        await new Promise((resolve) => {
            setTimeout(resolve, 50);
        });
        expect((taskStore.getTask as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAtDispose);
    });

    // Production TaskStore is Redis-backed (RedisTaskStore in the internal
    // repo). A transient HGET failure must NOT crash the pod via unhandled
    // rejection — the watcher must swallow it and the next successful tick
    // must still abort. Without this guarantee, a single Redis blip during
    // any active long-running task takes down every session on the worker.
    it('survives transient task store errors and aborts on the next successful tick', async () => {
        let call = 0;
        const taskStore = {
            getTask: vi.fn().mockImplementation(async () => {
                call += 1;
                if (call === 1) throw new Error('redis ETIMEDOUT');
                return { status: 'cancelled' };
            }),
        } as unknown as TaskStore;

        const watcher = createTaskCancellationWatcher({
            taskId: 't1',
            mcpSessionId: 's1',
            taskStore,
            pollIntervalMs: 10,
        });

        try {
            await vi.waitFor(
                () => {
                    expect(watcher.signal.aborted).toBe(true);
                },
                { timeout: 500, interval: 10 },
            );
            expect(call).toBeGreaterThanOrEqual(2);
        } finally {
            watcher.dispose();
        }
    });

    // Under Redis tail latency a single getTask can outlast pollIntervalMs.
    // Without overlap protection, ticks pile up and amplify load right when
    // the backend is already struggling. The watcher must serialize ticks.
    it('does not start a new poll while the previous one is still in flight', async () => {
        let resolveFirst: ((task: { status: string }) => void) | undefined;
        const firstCall = new Promise<{ status: string }>((resolve) => {
            resolveFirst = resolve;
        });
        const taskStore = {
            getTask: vi
                .fn()
                .mockImplementationOnce(async () => firstCall)
                .mockImplementation(async () => ({ status: 'working' })),
        } as unknown as TaskStore;

        const watcher = createTaskCancellationWatcher({
            taskId: 't1',
            mcpSessionId: 's1',
            taskStore,
            pollIntervalMs: 10,
        });

        try {
            // Wait far longer than pollIntervalMs while the first call hangs.
            await new Promise((resolve) => {
                setTimeout(resolve, 80);
            });
            expect((taskStore.getTask as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

            resolveFirst!({ status: 'working' });
            await vi.waitFor(
                () => {
                    expect((taskStore.getTask as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);
                },
                { timeout: 500, interval: 10 },
            );
        } finally {
            watcher.dispose();
        }
    });
});
