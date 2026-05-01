import { describe, expect, it, vi } from 'vitest';

import { callActorGetDataset } from '../../src/tools/core/actor_execution.js';

describe('callActorGetDataset', () => {
    it('should return null without starting a run when the signal is already aborted', async () => {
        const controller = new AbortController();
        controller.abort();

        const start = vi.fn();

        const apifyClient = {
            actor: vi.fn().mockReturnValue({ start }),
        };

        const result = await callActorGetDataset({
            actorName: 'apify/rag-web-browser',
            input: { query: 'https://apify.com' },
            apifyClient: apifyClient as never,
            abortSignal: controller.signal,
        });

        expect(result).toBeNull();
        expect(start).not.toHaveBeenCalled();
    });

    it('should abort and return null when the signal is aborted during actor start', async () => {
        const controller = new AbortController();
        const actorRun = {
            id: 'run-123',
            defaultDatasetId: 'dataset-123',
            status: 'RUNNING',
            usageTotalUsd: 0,
            usageUsd: {},
        };

        const abort = vi.fn().mockResolvedValue(undefined);
        const waitForFinish = vi.fn().mockResolvedValue(actorRun);
        const start = vi.fn().mockImplementation(async () => {
            controller.abort();
            return actorRun;
        });

        const apifyClient = {
            actor: vi.fn().mockReturnValue({
                start,
            }),
            run: vi.fn().mockReturnValue({
                abort,
                waitForFinish,
            }),
        };

        const result = await callActorGetDataset({
            actorName: 'apify/rag-web-browser',
            input: { query: 'https://apify.com' },
            apifyClient: apifyClient as never,
            abortSignal: controller.signal,
        });

        expect(result).toBeNull();
        expect(abort).toHaveBeenCalledWith({ gracefully: false });
        expect(waitForFinish).not.toHaveBeenCalled();
    });

    it('should abort and return null when cancelled after start even if waitForFinish resolves', async () => {
        const controller = new AbortController();
        const actorRun = {
            id: 'run-456',
            defaultDatasetId: 'dataset-456',
            status: 'RUNNING',
            usageTotalUsd: 0,
            usageUsd: {},
        };

        let resolveAbort: (() => void) | undefined;
        let resolveWaitForFinish: ((value: typeof actorRun) => void) | undefined;
        const abort = vi.fn().mockImplementation(async () => await new Promise<void>((resolve) => {
            resolveAbort = resolve;
        }));
        const waitForFinish = vi.fn().mockImplementation(async () => await new Promise<typeof actorRun>((resolve) => {
            resolveWaitForFinish = resolve;
        }));
        const start = vi.fn().mockResolvedValue(actorRun);
        const listItems = vi.fn().mockResolvedValue({ items: [], total: 0 });

        const apifyClient = {
            actor: vi.fn().mockReturnValue({ start }),
            run: vi.fn().mockReturnValue({ abort, waitForFinish }),
            dataset: vi.fn().mockReturnValue({ listItems }),
        };

        const resultPromise = callActorGetDataset({
            actorName: 'apify/rag-web-browser',
            input: { query: 'https://apify.com' },
            apifyClient: apifyClient as never,
            abortSignal: controller.signal,
        });

        await vi.waitUntil(() => Boolean(resolveWaitForFinish));
        controller.abort();
        resolveWaitForFinish!(actorRun);

        await vi.waitUntil(() => abort.mock.calls.length > 0);
        expect(abort).toHaveBeenCalledWith({ gracefully: false });
        expect(listItems).not.toHaveBeenCalled();
        resolveAbort!();

        const result = await resultPromise;

        expect(result).toBeNull();
        expect(listItems).not.toHaveBeenCalled();
    });

    it('should report the initial actor run status before waiting for finish', async () => {
        const actorRun = {
            id: 'run-789',
            defaultDatasetId: 'dataset-789',
            status: 'RUNNING',
            statusMessage: 'Loading page',
            usageTotalUsd: 0,
            usageUsd: {},
        };
        const updateProgress = vi.fn().mockResolvedValue(undefined);
        const startActorRunUpdates = vi.fn();
        const waitForFinish = vi.fn().mockResolvedValue(actorRun);
        const start = vi.fn().mockResolvedValue(actorRun);
        const listItems = vi.fn().mockResolvedValue({ items: [], total: 0 });
        const getDefaultBuild = vi.fn().mockResolvedValue(undefined);

        const apifyClient = {
            actor: vi.fn().mockReturnValue({ start, defaultBuild: vi.fn().mockResolvedValue({ get: getDefaultBuild }) }),
            run: vi.fn().mockReturnValue({ waitForFinish }),
            dataset: vi.fn().mockReturnValue({ listItems }),
        };

        await callActorGetDataset({
            actorName: 'apify/rag-web-browser',
            input: { query: 'https://apify.com' },
            apifyClient: apifyClient as never,
            progressTracker: { updateProgress, startActorRunUpdates } as never,
        });

        expect(updateProgress).toHaveBeenCalledWith('apify/rag-web-browser: Loading page');
        expect(startActorRunUpdates).toHaveBeenCalledWith('run-789', apifyClient, 'apify/rag-web-browser');
        expect(updateProgress.mock.invocationCallOrder[0]).toBeLessThan(waitForFinish.mock.invocationCallOrder[0]);
    });
});
