import { describe, expect, it, vi } from 'vitest';

import { callActorGetDataset } from '../../src/tools/core/actor_execution.js';

describe('callActorGetDataset', () => {
    it('should abort and return null when the signal is aborted during actor start', async () => {
        const controller = new AbortController();
        const actorRun = {
            id: 'run-123',
            defaultDatasetId: 'dataset-123',
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

    it('should return null immediately when cancelled after start even if API abort is slow', async () => {
        const controller = new AbortController();
        const actorRun = {
            id: 'run-456',
            defaultDatasetId: 'dataset-456',
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
        const get = vi.fn().mockResolvedValue({ actorDefinition: { storages: {} } });

        const apifyClient = {
            actor: vi.fn().mockReturnValue({
                start,
                defaultBuild: vi.fn().mockResolvedValue({ get }),
            }),
            run: vi.fn().mockReturnValue({
                abort,
                waitForFinish,
            }),
            dataset: vi.fn().mockReturnValue({
                listItems,
            }),
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

        const result = await resultPromise;

        expect(result).toBeNull();
        await vi.waitUntil(() => abort.mock.calls.length > 0);
        expect(abort).toHaveBeenCalledWith({ gracefully: false });
        expect(listItems).not.toHaveBeenCalled();
        resolveAbort!();
    });
});
