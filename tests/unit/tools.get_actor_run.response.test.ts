import type { ActorRun } from 'apify-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    buildStartRunResponse,
    buildStartRunWidgetResponse,
    buildStatusSummaryNextStep,
    collapseArrayIndices,
    type RunDataset,
    type RunKeyValueStore,
    type RunResponse,
} from '../../src/tools/actors/actor_run_response.js';
import { getActorRun } from '../../src/tools/runs/get_actor_run.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import { VERBATIM_LINKS_NUDGE } from '../../src/utils/console_link.js';
import { getUserInfoCached } from '../../src/utils/userid_cache.js';
import { mockUserInfo, stubToolCallContext, type TextToolResult } from './helpers/tool_context.js';

// Only Console UI token sessions reach the users/me lookup; the default 'test-token'
// stub never triggers it.
vi.mock('../../src/utils/userid_cache.js', () => ({
    getUserInfoCached: vi.fn(),
}));

/**
 * Default mode `get-actor-run` returns: runId, actorId, status, storages, summary, nextStep
 * — with no inlined dataset items or KV record bodies.
 * Tests cover shape invariants and the branching status templates (SUCCEEDED, TIMED-OUT).
 * Pure-template states (READY, RUNNING, TIMING-OUT, ABORTING, FAILED, ABORTED) are intentionally
 * not asserted here — see the comment above `describe('buildStatusTemplate', ...)` below.
 */

const ACTOR = { username: 'apify', name: 'rag-web-browser' };

function mockSucceededRun(overrides: Record<string, unknown> = {}) {
    return {
        id: 'run-1',
        actId: 'actor-id-1',
        status: 'SUCCEEDED',
        startedAt: new Date('2026-05-01T10:00:00.000Z'),
        finishedAt: new Date('2026-05-01T10:00:22.000Z'),
        statusMessage: undefined,
        exitCode: 0,
        defaultDatasetId: 'dataset-xyz',
        defaultKeyValueStoreId: 'kv-xyz',
        stats: { runTimeSecs: 22, computeUnits: 0.04, memMaxBytes: 268435456 },
        usageTotalUsd: 0.0001,
        usageUsd: { ACTOR_COMPUTE_UNITS: 0.0001 },
        ...overrides,
    };
}

function mockDataset(overrides: Record<string, unknown> = {}) {
    return {
        id: 'dataset-xyz',
        createdAt: new Date('2026-05-01T10:00:00.000Z'),
        modifiedAt: new Date('2026-05-01T10:00:22.000Z'),
        itemCount: 47,
        // Apify returns slash-notation; server must translate to dot-notation in the response.
        fields: ['crawl/httpStatusCode', 'metadata/url', 'markdown'],
        stats: { writeCount: 47, storageBytes: 152340 },
        ...overrides,
    };
}

function stubClient(opts: {
    run: unknown;
    dataset?: unknown;
    listKeys?: { items: { key: string }[]; isTruncated: boolean; count?: number };
    listItemsProbe?: { items: unknown[]; total?: number };
}): InternalToolArgs['apifyClient'] {
    const { run, dataset, listKeys, listItemsProbe } = opts;
    return {
        run: (_id: string) => ({
            get: async () => run,
            waitForFinish: async () => run,
        }),
        actor: (_id: string) => ({ get: async () => ACTOR }),
        dataset: (_id: string) => ({
            get: async () => dataset ?? null,
            listItems: async () => listItemsProbe ?? { items: [], total: 0 },
        }),
        keyValueStore: (_id: string) => ({
            listKeys: async () => listKeys ?? { items: [], count: 0, isTruncated: false, limit: 50 },
        }),
    } as unknown as InternalToolArgs['apifyClient'];
}

describe('get-actor-run default response', () => {
    it('end-to-end SUCCEEDED: translates fields, omits legacy preview, carries identifiers in text, attaches usage _meta', async () => {
        const run = mockSucceededRun();
        const result = await (getActorRun as HelperTool).call(
            stubToolCallContext({ runId: 'run-1', waitSecs: 0 }, stubClient({ run, dataset: mockDataset() })),
        );

        const { structuredContent, content, _meta } = result as {
            structuredContent: RunResponse;
            content: { type: string; text: string }[];
            _meta?: Record<string, unknown>;
        };

        // Slash-to-dot translation on dataset.fields. Mock returns `crawl/httpStatusCode`; response must rewrite to `crawl.httpStatusCode`.
        expect(structuredContent.storages.datasets?.default.fields).toEqual([
            'crawl.httpStatusCode',
            'metadata.url',
            'markdown',
        ]);

        // actorName composed from `${username}/${name}`.
        expect(structuredContent.actorName).toBe('apify/rag-web-browser');

        // No legacy preview field and no inlined item bodies anywhere on the response.
        const dump = JSON.stringify(structuredContent);
        expect(dump).not.toContain('previewItems');
        expect(dump).not.toContain('"items":');

        // content[0] mirrors structuredContent as JSON (MCP spec backwards-compat); content[1] is
        // the LLM-readable narrative with identifiers interpolated.
        expect(content).toHaveLength(2);
        expect(JSON.parse(content[0].text)).toEqual(structuredContent);
        expect(content[1].text).toContain('dataset-xyz');
        expect(content[1].text).not.toContain('```json');

        // Usage attribution `_meta` flows through end-to-end.
        expect(_meta?.['com.apify/ActorRun']).toEqual({
            usageTotalUsd: 0.0001,
            usageUsd: { ACTOR_COMPUTE_UNITS: 0.0001 },
        });
    });

    it('surfaces dataset inflatedBytes from stats in structuredContent', async () => {
        // The single-dataset GET does not return `inflatedBytes` (only the dataset-list endpoint does);
        // this stub injects it to verify the wiring.
        const run = mockSucceededRun();
        const result = await (getActorRun as HelperTool).call(
            stubToolCallContext(
                { runId: 'run-1', waitSecs: 0 },
                stubClient({ run, dataset: mockDataset({ stats: { writeCount: 47, inflatedBytes: 1234 } }) }),
            ),
        );
        const { structuredContent } = result as { structuredContent: RunResponse };

        expect(structuredContent.storages.datasets?.default.inflatedBytes).toBe(1234);
    });

    it('omits inflatedBytes when the platform reports 0 (size unavailable, not a real 0)', async () => {
        // The platform returns inflatedBytes: 0 when it does not yet populate the size; surfacing a
        // literal "0 bytes" is misleading for a non-empty dataset, so the field must be omitted.
        const run = mockSucceededRun();
        const result = await (getActorRun as HelperTool).call(
            stubToolCallContext(
                { runId: 'run-1', waitSecs: 0 },
                stubClient({ run, dataset: mockDataset({ stats: { writeCount: 47, inflatedBytes: 0 } }) }),
            ),
        );
        const { structuredContent } = result as { structuredContent: RunResponse };

        expect(structuredContent.storages.datasets?.default.inflatedBytes).toBeUndefined();
    });

    it('fetches dataset metadata for a non-terminal RUNNING run and surfaces progress in the summary', async () => {
        // Dataset metadata is fetched on every poll so the summary can surface partial progress.
        // KV listKeys stays terminal-only — non-terminal summaries don't reference KV records, so
        // fetching them would be pure waste on the widget poll hot path.
        let datasetCalls = 0;
        let kvCalls = 0;
        const run = { ...mockSucceededRun({ status: 'RUNNING', finishedAt: undefined }), exitCode: undefined };
        const client = {
            run: (_id: string) => ({ get: async () => run, waitForFinish: async () => run }),
            actor: (_id: string) => ({ get: async () => ACTOR }),
            dataset: (_id: string) => {
                datasetCalls += 1;
                return {
                    get: async () => mockDataset({ itemCount: 127 }),
                    listItems: async () => ({ items: [], total: 0 }),
                };
            },
            keyValueStore: (_id: string) => {
                kvCalls += 1;
                return { listKeys: async () => ({ items: [], count: 0, isTruncated: false, limit: 50 }) };
            },
        } as unknown as InternalToolArgs['apifyClient'];

        const result = await (getActorRun as HelperTool).call(
            stubToolCallContext({ runId: 'run-1', waitSecs: 0 }, client),
        );
        const { structuredContent } = result as { structuredContent: RunResponse };

        expect(structuredContent.status).toBe('RUNNING');
        expect(structuredContent.storages.datasets?.default.id).toBe('dataset-xyz');
        // Non-terminal now populates itemCount/fields too — needed for the progress suffix.
        expect(structuredContent.storages.datasets?.default.itemCount).toBe(127);
        expect(structuredContent.storages.datasets?.default.fields).toEqual([
            'crawl.httpStatusCode',
            'metadata.url',
            'markdown',
        ]);
        expect(structuredContent.summary).toContain('127 results so far.');
        expect(datasetCalls).toBe(1);
        expect(kvCalls).toBe(0);
    });

    it('triggers the itemCount=0 lag-fallback probe on terminal SUCCEEDED', async () => {
        const run = mockSucceededRun();
        const dataset = mockDataset({ itemCount: 0 });
        // Probe runs with `limit: 1`, so `items.length === 1` even when the dataset has more.
        // The recovered count must come from `total`, otherwise the lag fallback caps at 1.
        const result = await (getActorRun as HelperTool).call(
            stubToolCallContext(
                { runId: 'run-1', waitSecs: 0 },
                stubClient({ run, dataset, listItemsProbe: { items: [{ a: 1 }], total: 47 } }),
            ),
        );
        const { structuredContent } = result as { structuredContent: RunResponse };
        expect(structuredContent.storages.datasets?.default.itemCount).toBe(47);
    });

    it('recovers a lagging itemCount=0 for an aliased dataset via the probe, not just the default', async () => {
        // Reproduces the aliased-storage bug: Apify's counter lags ~5s post-SUCCEEDED, so a freshly
        // written aliased dataset reports itemCount 0 in metadata. The probe must recover it for
        // aliases too, exactly as it does for the default.
        const run = mockSucceededRun({
            storageIds: { datasets: { default: 'dataset-xyz', results: 'dataset-results' } },
        });
        const client = {
            run: (_id: string) => ({ get: async () => run, waitForFinish: async () => run }),
            actor: (_id: string) => ({ get: async () => ACTOR }),
            dataset: (id: string) => ({
                // Both datasets report a stale itemCount 0 in metadata...
                get: async () => mockDataset({ id, itemCount: 0 }),
                // ...but listItems.total reflects the true count (distinct per dataset).
                listItems: async () => ({ items: [{ a: 1 }], total: id === 'dataset-results' ? 3 : 1 }),
            }),
            keyValueStore: (_id: string) => ({
                listKeys: async () => ({ items: [], count: 0, isTruncated: false, limit: 50 }),
            }),
        } as unknown as InternalToolArgs['apifyClient'];

        const result = await (getActorRun as HelperTool).call(
            stubToolCallContext({ runId: 'run-1', waitSecs: 0 }, client),
        );
        const { structuredContent } = result as { structuredContent: RunResponse };
        expect(structuredContent.storages.datasets?.default.itemCount).toBe(1);
        expect(structuredContent.storages.datasets?.results.itemCount).toBe(3);
    });

    it('retries the itemCount=0 probe once when the first probe also returns 0 (waitSecs > 0)', async () => {
        // Delayed retries run only when waitSecs > 0 — they're skipped on the "return immediately"
        // path. Drive the [0, 1000, ...]ms schedule with fake timers.
        vi.useFakeTimers();
        try {
            const run = mockSucceededRun();
            const dataset = mockDataset({ itemCount: 0 });
            let probeCalls = 0;
            const client = {
                run: (_id: string) => ({ get: async () => run, waitForFinish: async () => run }),
                actor: (_id: string) => ({ get: async () => ACTOR }),
                dataset: (_id: string) => ({
                    get: async () => dataset,
                    listItems: async () => {
                        probeCalls += 1;
                        return probeCalls === 1 ? { items: [], total: 0 } : { items: [{ a: 1 }], total: 47 };
                    },
                }),
                keyValueStore: (_id: string) => ({
                    listKeys: async () => ({ items: [], count: 0, isTruncated: false, limit: 50 }),
                }),
            } as unknown as InternalToolArgs['apifyClient'];

            const callPromise = (getActorRun as HelperTool).call(
                stubToolCallContext({ runId: 'run-1', waitSecs: 5 }, client),
            );
            await vi.runAllTimersAsync();
            const result = await callPromise;
            const { structuredContent } = result as { structuredContent: RunResponse };
            expect(probeCalls).toBe(2);
            expect(structuredContent.storages.datasets?.default.itemCount).toBe(47);
        } finally {
            vi.useRealTimers();
        }
    });

    it('exhausts the full lag-fallback schedule when every probe returns 0, then reports 0', async () => {
        // Pin the full 4-probe schedule covering Apify's ~5s itemCount propagation lag window
        // (see ITEM_COUNT_PROBE_DELAYS_MS). If a future change shortens or removes retries, this
        // test fails — we don't want SUCCEEDED-but-empty races to silently regress.
        vi.useFakeTimers();
        try {
            const run = mockSucceededRun();
            const dataset = mockDataset({ itemCount: 0 });
            let probeCalls = 0;
            const client = {
                run: (_id: string) => ({ get: async () => run, waitForFinish: async () => run }),
                actor: (_id: string) => ({ get: async () => ACTOR }),
                dataset: (_id: string) => ({
                    get: async () => dataset,
                    listItems: async () => {
                        probeCalls += 1;
                        return { items: [], total: 0 };
                    },
                }),
                keyValueStore: (_id: string) => ({
                    listKeys: async () => ({ items: [], count: 0, isTruncated: false, limit: 50 }),
                }),
            } as unknown as InternalToolArgs['apifyClient'];

            const callPromise = (getActorRun as HelperTool).call(
                stubToolCallContext({ runId: 'run-1', waitSecs: 5 }, client),
            );
            // Drive the [0, 1000, 2000, 2000]ms schedule to completion without real wall time.
            await vi.runAllTimersAsync();
            const result = await callPromise;
            const { structuredContent } = result as { structuredContent: RunResponse };

            expect(probeCalls).toBe(4);
            expect(structuredContent.storages.datasets?.default.itemCount).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('skips delayed lag-fallback retries when waitSecs=0 (immediate-poll contract)', async () => {
        // Regression for the widget's initial render: the [0, 1000, 2000, 2000]ms retry schedule
        // would block "return immediately" callers for ~5s on a SUCCEEDED-but-empty dataset.
        const run = mockSucceededRun();
        const dataset = mockDataset({ itemCount: 0 });
        let probeCalls = 0;
        const client = {
            run: (_id: string) => ({ get: async () => run, waitForFinish: async () => run }),
            actor: (_id: string) => ({ get: async () => ACTOR }),
            dataset: (_id: string) => ({
                get: async () => dataset,
                listItems: async () => {
                    probeCalls += 1;
                    return { items: [], total: 0 };
                },
            }),
            keyValueStore: (_id: string) => ({
                listKeys: async () => ({ items: [], count: 0, isTruncated: false, limit: 50 }),
            }),
        } as unknown as InternalToolArgs['apifyClient'];

        await (getActorRun as HelperTool).call(stubToolCallContext({ runId: 'run-1', waitSecs: 0 }, client));
        // Exactly one immediate probe — no delayed retries.
        expect(probeCalls).toBe(1);
    });

    it('returns promptly when extra.signal is already aborted before raceAbort attaches its listener', async () => {
        // Regression: without `raceAbort`'s pre-attach `aborted` check, an already-aborted signal
        // would block forever — the abort event has already fired by the time the listener attaches.
        const controller = new AbortController();
        controller.abort();

        let getCalls = 0;
        const client = {
            run: (_id: string) => ({
                get: async () => {
                    getCalls += 1;
                    return new Promise(() => {
                        /* never resolves — only the abort path can return */
                    });
                },
                waitForFinish: async () =>
                    new Promise(() => {
                        /* never resolves */
                    }),
            }),
            actor: (_id: string) => ({ get: async () => ACTOR }),
            dataset: (_id: string) => ({ get: async () => null, listItems: async () => ({ items: [], total: 0 }) }),
            keyValueStore: (_id: string) => ({
                listKeys: async () => ({ items: [], count: 0, isTruncated: false, limit: 50 }),
            }),
        } as unknown as InternalToolArgs['apifyClient'];

        const result = await (getActorRun as HelperTool).call({
            ...stubToolCallContext({ runId: 'run-1', waitSecs: 0 }, client),
            extra: { signal: controller.signal } as InternalToolArgs['extra'],
        });

        // Cancelled requests return no payload per MCP spec — see `getActorRun`.
        expect(result).toEqual({});
        // ≤1 because raceAbort may short-circuit before or after `run().get()` is invoked; what
        // matters is that the call returns instead of hanging on the never-resolving promise.
        expect(getCalls).toBeLessThanOrEqual(1);
    });

    it('rejects waitSecs above 45', () => {
        const tool = getActorRun as HelperTool;
        expect(tool.ajvValidate({ runId: 'run-1', waitSecs: 46 })).toBe(false);
    });

    it('rejects waitSecs below 0', () => {
        const tool = getActorRun as HelperTool;
        expect(tool.ajvValidate({ runId: 'run-1', waitSecs: -1 })).toBe(false);
    });

    it('degrades gracefully when dataset metadata fetch fails: keeps SUCCEEDED, points at dataset', async () => {
        const run = mockSucceededRun();
        const client = {
            run: (_id: string) => ({ get: async () => run, waitForFinish: async () => run }),
            actor: (_id: string) => ({ get: async () => ACTOR }),
            dataset: (_id: string) => ({
                get: async () => {
                    throw new Error('transient network error');
                },
                listItems: async () => ({ items: [], total: 0 }),
            }),
            keyValueStore: (_id: string) => ({
                listKeys: async () => ({ items: [], count: 0, isTruncated: false, limit: 50 }),
            }),
        } as unknown as InternalToolArgs['apifyClient'];

        const result = await (getActorRun as HelperTool).call(
            stubToolCallContext({ runId: 'run-1', waitSecs: 0 }, client),
        );
        const { content, structuredContent, isError } = result as TextToolResult & { structuredContent: RunResponse };

        // The whole call must NOT hard-fail just because one metadata fetch errored.
        expect(isError).not.toBe(true);
        expect(structuredContent.status).toBe('SUCCEEDED');

        // Dataset id is still surfaced (the agent can fetch items directly even without metadata).
        expect(structuredContent.storages.datasets?.default.id).toBe('dataset-xyz');
        expect(structuredContent.storages.datasets?.default.itemCount).toBeUndefined();
        expect(structuredContent.storages.datasets?.default.fields).toBeUndefined();

        // nextStep points at get-dataset-items, not the "no output / re-run" branch.
        expect(structuredContent.nextStep).toContain('get-dataset-items');
        expect(structuredContent.nextStep).toContain('datasetId=dataset-xyz');
        // Narrative (content[1]) avoids the "re-run" branch wording.
        expect(content[1].text).not.toContain('No dataset items and no key-value records were found');
        expect(content[1].text).not.toMatch(/re-run/i);
    });

    it('degrades gracefully when KV listKeys fails: keeps dataset, omits KV', async () => {
        const run = mockSucceededRun();
        const client = {
            run: (_id: string) => ({ get: async () => run, waitForFinish: async () => run }),
            actor: (_id: string) => ({ get: async () => ACTOR }),
            dataset: (_id: string) => ({
                get: async () => mockDataset(),
                listItems: async () => ({ items: [], total: 0 }),
            }),
            keyValueStore: (_id: string) => ({
                listKeys: async () => {
                    throw new Error('transient KV error');
                },
            }),
        } as unknown as InternalToolArgs['apifyClient'];

        const result = await (getActorRun as HelperTool).call(
            stubToolCallContext({ runId: 'run-1', waitSecs: 0 }, client),
        );
        const { structuredContent, isError } = result as { structuredContent: RunResponse; isError?: boolean };

        expect(isError).not.toBe(true);
        expect(structuredContent.status).toBe('SUCCEEDED');
        expect(structuredContent.storages.datasets?.default.itemCount).toBe(47);
        // KV id is still surfaced from the run record; the failed listKeys just leaves keys unknown.
        expect(structuredContent.storages.keyValueStores?.default.id).toBe('kv-xyz');
        expect(structuredContent.storages.keyValueStores?.default.keys).toBeUndefined();
        expect(structuredContent.storages.keyValueStores?.default.keyCount).toBeUndefined();
    });

    it('enriches aliased storages from run.storageIds with their own metadata, not just the default', async () => {
        const run = mockSucceededRun({
            storageIds: {
                datasets: { default: 'dataset-xyz', results: 'dataset-results' },
                keyValueStores: { default: 'kv-xyz', screenshots: 'kv-screenshots' },
            },
        });
        // Per-id metadata so default and alias entries are distinguishable.
        const datasetsById: Record<string, ReturnType<typeof mockDataset>> = {
            'dataset-xyz': mockDataset({ id: 'dataset-xyz', itemCount: 47 }),
            'dataset-results': mockDataset({ id: 'dataset-results', itemCount: 5, fields: ['error'] }),
        };
        const kvKeysById: Record<string, { key: string }[]> = {
            'kv-xyz': [{ key: 'OUTPUT' }],
            'kv-screenshots': [{ key: 'shot-1' }, { key: 'shot-2' }],
        };
        const client = {
            run: (_id: string) => ({ get: async () => run, waitForFinish: async () => run }),
            actor: (_id: string) => ({ get: async () => ACTOR }),
            dataset: (id: string) => ({
                get: async () => datasetsById[id] ?? null,
                listItems: async () => ({ items: [], total: 0 }),
            }),
            keyValueStore: (id: string) => ({
                listKeys: async () => ({ items: kvKeysById[id] ?? [], isTruncated: false }),
            }),
        } as unknown as InternalToolArgs['apifyClient'];

        const result = await (getActorRun as HelperTool).call(
            stubToolCallContext({ runId: 'run-1', waitSecs: 0 }, client),
        );
        const { structuredContent } = result as { structuredContent: RunResponse };

        // default stays enriched.
        expect(structuredContent.storages.datasets?.default.itemCount).toBe(47);
        expect(structuredContent.storages.keyValueStores?.default.keys).toEqual(['OUTPUT']);
        // Aliased dataset carries its own id, itemCount, and normalized fields — not the default's.
        expect(structuredContent.storages.datasets?.results).toMatchObject({
            id: 'dataset-results',
            itemCount: 5,
            fields: ['error'],
        });
        // Aliased KV store carries its own keys.
        expect(structuredContent.storages.keyValueStores?.screenshots).toMatchObject({
            id: 'kv-screenshots',
            keys: ['shot-1', 'shot-2'],
            keyCount: 2,
        });
    });

    it('emits progress with formatted status messages on wait + terminal flip', async () => {
        // RUNNING with a non-terminal statusMessage at start; SUCCEEDED with a terminal statusMessage
        // at end. formatRunStatusMessage suppresses non-terminal-marked statusMessages on terminal
        // states, so the second emission must keep the terminal one.
        const initialRun = {
            ...mockSucceededRun({
                status: 'RUNNING',
                finishedAt: undefined,
                statusMessage: 'Crawling 1/10',
            }),
            exitCode: undefined,
        };
        const finalRun = mockSucceededRun({
            statusMessage: 'Done',
            isStatusMessageTerminal: true,
        });

        let runFetchCount = 0;
        const client = {
            // First .get() returns RUNNING; the post-waitForFinish re-fetch returns the terminal run.
            run: (_id: string) => ({
                get: async () => {
                    runFetchCount += 1;
                    return runFetchCount === 1 ? initialRun : finalRun;
                },
                waitForFinish: async () => finalRun,
            }),
            actor: (_id: string) => ({ get: async () => ACTOR }),
            dataset: (_id: string) => ({
                get: async () => mockDataset(),
                listItems: async () => ({ items: [], total: 0 }),
            }),
            keyValueStore: (_id: string) => ({
                listKeys: async () => ({ items: [], count: 0, isTruncated: false, limit: 50 }),
            }),
        } as unknown as InternalToolArgs['apifyClient'];

        const updateProgressCalls: string[] = [];
        const startActorRunUpdatesCalls: string[] = [];
        let stopCount = 0;
        const tracker = {
            updateProgress: async (msg: string) => {
                updateProgressCalls.push(msg);
            },
            startActorRunUpdates: (runId: string) => {
                startActorRunUpdatesCalls.push(runId);
            },
            stop: () => {
                stopCount += 1;
            },
        };

        const baseArgs = stubToolCallContext({ runId: 'run-1', waitSecs: 5 }, client);
        await (getActorRun as HelperTool).call({
            ...baseArgs,
            progressTracker: tracker as unknown as InternalToolArgs['progressTracker'],
        });

        // Two emissions: pre-wait (initial RUNNING + non-terminal statusMessage) and post-wait
        // (terminal SUCCEEDED + terminal-marked statusMessage). Format is `${actorName}: ${status}[ — ${msg}]`.
        expect(updateProgressCalls).toEqual([
            'apify/rag-web-browser: RUNNING — Crawling 1/10',
            'apify/rag-web-browser: SUCCEEDED — Done',
        ]);
        expect(startActorRunUpdatesCalls).toEqual(['run-1']);
        expect(stopCount).toBe(1);
    });

    it('returns isError on a missing run', async () => {
        const client = {
            run: (_id: string) => ({ get: async () => undefined }),
            actor: (_id: string) => ({ get: async () => ACTOR }),
        } as unknown as InternalToolArgs['apifyClient'];
        const result = (await (getActorRun as HelperTool).call(
            stubToolCallContext({ runId: 'missing', waitSecs: 0 }, client),
        )) as TextToolResult;
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('not found');
    });

    describe('Console UI token sessions (personalized Console links)', () => {
        beforeEach(() => {
            vi.mocked(getUserInfoCached).mockReset();
        });

        it('mints run + dataset + KV Console links and appends the Console line + nudge to the narrative', async () => {
            vi.mocked(getUserInfoCached).mockResolvedValue(mockUserInfo());

            const run = mockSucceededRun();
            const result = await (getActorRun as HelperTool).call({
                ...stubToolCallContext({ runId: 'run-1', waitSecs: 0 }, stubClient({ run, dataset: mockDataset() })),
                apifyToken: 'apify_ui_test',
            });
            const { structuredContent, content } = result as {
                structuredContent: RunResponse;
                content: { type: string; text: string }[];
            };

            expect(structuredContent.apifyConsoleUrl).toBe('https://console.apify.com/actors/runs/run-1');
            expect(structuredContent.storages.datasets?.default.apifyConsoleUrl).toBe(
                'https://console.apify.com/storage/datasets/dataset-xyz',
            );
            expect(structuredContent.storages.keyValueStores?.default.apifyConsoleUrl).toBe(
                'https://console.apify.com/storage/key-value-stores/kv-xyz',
            );

            // content[0] JSON mirror carries the links; content[1] narrative lists them + nudge.
            expect(JSON.parse(content[0].text)).toEqual(structuredContent);
            expect(content[1].text).toContain(
                'Apify Console: run https://console.apify.com/actors/runs/run-1 | dataset https://console.apify.com/storage/datasets/dataset-xyz | key-value store https://console.apify.com/storage/key-value-stores/kv-xyz',
            );
            expect(content[1].text).toContain(VERBATIM_LINKS_NUDGE);
        });

        it('keeps responses link-free for API tokens', async () => {
            const run = mockSucceededRun();
            const result = await (getActorRun as HelperTool).call({
                ...stubToolCallContext({ runId: 'run-1', waitSecs: 0 }, stubClient({ run, dataset: mockDataset() })),
                apifyToken: 'apify_api_test',
            });
            const { structuredContent, content } = result as {
                structuredContent: RunResponse;
                content: { type: string; text: string }[];
            };

            expect(getUserInfoCached).not.toHaveBeenCalled();
            expect(structuredContent.apifyConsoleUrl).toBeUndefined();
            expect(content[1].text).not.toContain('console.apify.com');
        });
    });
});

// -----------------------------------------------------------------------------
// buildStartRunResponse — the "fire and forget" (waitSecs=0) response builder
// -----------------------------------------------------------------------------

// Shared by buildStartRunResponse() and buildStartRunWidgetResponse() below — both builders
// consume the same ActorRun shape.
const actorRun = {
    id: 'run-abc',
    actId: 'actor-xyz',
    status: 'RUNNING',
    startedAt: new Date('2026-01-02T03:04:05.000Z'),
    defaultDatasetId: 'dataset-abc',
    defaultKeyValueStoreId: 'kv-abc',
} as unknown as ActorRun;

describe('buildStartRunResponse()', () => {
    it('builds correct RunResponse shape without widget metadata', () => {
        const result = buildStartRunResponse({ actorName: 'apify/rag-web-browser', actorRun });

        const { structuredContent, content, _meta } = result as {
            structuredContent: RunResponse;
            content: { type: string; text: string }[];
            _meta?: Record<string, unknown>;
        };

        expect(structuredContent.runId).toBe('run-abc');
        expect(structuredContent.actorId).toBe('actor-xyz');
        expect(structuredContent.actorName).toBe('apify/rag-web-browser');
        expect(structuredContent.status).toBe('RUNNING');
        expect(structuredContent.startedAt).toBe('2026-01-02T03:04:05.000Z');
        expect(structuredContent.storages.datasets?.default.id).toBe('dataset-abc');
        expect(structuredContent.storages.keyValueStores?.default.id).toBe('kv-abc');
        expect(structuredContent.summary).toBeDefined();
        expect(structuredContent.nextStep).toBeDefined();

        // content[0] is JSON mirror; content[1] is LLM-readable narrative.
        expect(content).toHaveLength(2);
        expect(JSON.parse(content[0].text)).toEqual(structuredContent);

        // Non-widget path: no widget _meta.
        expect(_meta).toBeUndefined();
    });

    it('emits id-only entries for aliased storages from run.storageIds', () => {
        const runWithAliases = {
            ...actorRun,
            storageIds: {
                datasets: { default: 'dataset-abc', errors: 'dataset-errors' },
                keyValueStores: { default: 'kv-abc', debug: 'kv-debug' },
            },
        } as unknown as ActorRun;

        const result = buildStartRunResponse({ actorName: 'apify/rag-web-browser', actorRun: runWithAliases });
        const { structuredContent } = result as { structuredContent: RunResponse };

        expect(structuredContent.storages.datasets).toEqual({
            default: { id: 'dataset-abc' },
            errors: { id: 'dataset-errors' },
        });
        expect(structuredContent.storages.keyValueStores).toEqual({
            default: { id: 'kv-abc' },
            debug: { id: 'kv-debug' },
        });
    });

    // Org-prefixed URL variants are covered by the builder tests in console_link.test.ts.
    it('mints Console links and appends the Console line when linkContext is set', () => {
        const result = buildStartRunResponse({
            actorName: 'apify/rag-web-browser',
            actorRun,
            linkContext: {},
        });

        const { structuredContent, content } = result as {
            structuredContent: RunResponse;
            content: { type: string; text: string }[];
        };

        expect(structuredContent.apifyConsoleUrl).toBe('https://console.apify.com/actors/runs/run-abc');
        expect(structuredContent.storages.datasets?.default.apifyConsoleUrl).toBe(
            'https://console.apify.com/storage/datasets/dataset-abc',
        );
        expect(structuredContent.storages.keyValueStores?.default.apifyConsoleUrl).toBe(
            'https://console.apify.com/storage/key-value-stores/kv-abc',
        );
        expect(JSON.parse(content[0].text)).toEqual(structuredContent);
        expect(content[1].text).toContain('Apify Console: run https://console.apify.com/actors/runs/run-abc');
        expect(content[1].text).toContain(VERBATIM_LINKS_NUDGE);
    });
});

describe('buildStartRunWidgetResponse()', () => {
    it('includes widget metadata and a no-poll nextStep', () => {
        const result = buildStartRunWidgetResponse({
            actorName: 'apify/rag-web-browser',
            actorRun,
        });

        const { structuredContent, _meta } = result as {
            structuredContent: RunResponse;
            _meta?: Record<string, unknown>;
        };

        expect(_meta).toBeDefined();
        expect(_meta?.['openai/widgetDescription']).toBe('Actor run progress for apify/rag-web-browser');
        expect(structuredContent.nextStep).toContain('Do NOT poll');
    });
});

// -----------------------------------------------------------------------------
// Status templates — one assertion per state (covers all 8 Apify statuses).
// -----------------------------------------------------------------------------

function makeRun(status: string, statusMessage?: string, runTimeSecs = 10) {
    return {
        id: 'run-X',
        actId: 'actor-X',
        status,
        statusMessage,
        startedAt: new Date(Date.now() - runTimeSecs * 1000),
        stats: { runTimeSecs },
    } as Parameters<typeof buildStatusSummaryNextStep>[0]['run'];
}

const datasetWithItems: RunDataset = { id: 'ds-1', itemCount: 47, fields: ['metadata.url', 'markdown'] };
const datasetEmpty: RunDataset = { id: 'ds-1', itemCount: 0, fields: [] };
const kvWithRecords: RunKeyValueStore = { id: 'kv-1', keys: ['result-a', 'result-b'], keyCount: 2 };

/**
 * Tests below cover real branching in buildSucceededSummaryNextStep / buildTimedOutSummaryNextStep
 * (3 branches each) and the dataset-vs-KV priority + truncation-labelling rules. Pure template
 * re-statements (READY/RUNNING/TIMING-OUT/ABORTING/FAILED/ABORTED) are deliberately not tested
 * here — they would just spell-check the format string and would change in lockstep with any
 * wording tweak. Default-mode integration coverage exercises the dispatch path.
 */
describe('buildStatusTemplate', () => {
    it('SUCCEEDED with dataset items routes to dataset-items nextStep', () => {
        const t = buildStatusSummaryNextStep({
            run: makeRun('SUCCEEDED'),
            dataset: datasetWithItems,
        });
        expect(t.summary).toContain('47 items; 2 fields available');
        expect(t.nextStep).toContain('get-dataset-items');
        expect(t.nextStep).toContain('datasetId=ds-1');
        expect(t.nextStep).toContain('metadata.url, markdown');
    });

    it('SUCCEEDED dataset nextStep uses DEFAULT_DATASET_ITEMS_LIMIT as example limit', () => {
        const t = buildStatusSummaryNextStep({
            run: makeRun('SUCCEEDED'),
            dataset: datasetWithItems,
        });
        expect(t.nextStep).toContain('limit (for example 20)');
    });

    it('SUCCEEDED steers nextStep away from fetching a large dataset', () => {
        const dataset: RunDataset = { id: 'ds-1', itemCount: 47, fields: ['metadata.url'], inflatedBytes: 2_400_000 };
        const t = buildStatusSummaryNextStep({ run: makeRun('SUCCEEDED'), dataset });
        expect(t.summary).toContain('47 items; 1 fields available');
        expect(t.nextStep).toContain('Full output is ~2400000 bytes');
        expect(t.nextStep).toContain('page with offset');
    });

    it('SUCCEEDED reports size but omits the large-output warning below the threshold', () => {
        const dataset: RunDataset = { id: 'ds-1', itemCount: 2, fields: [], inflatedBytes: 4000 };
        const t = buildStatusSummaryNextStep({ run: makeRun('SUCCEEDED'), dataset });
        expect(t.summary).toContain('2 items');
        expect(t.nextStep).toContain('Full output is ~4000 bytes');
        expect(t.nextStep).not.toContain('may exceed context');
    });

    it('SUCCEEDED omits the size hint entirely when the dataset size is unknown', () => {
        const dataset: RunDataset = { id: 'ds-1', itemCount: 2, fields: [] };
        const t = buildStatusSummaryNextStep({ run: makeRun('SUCCEEDED'), dataset });
        expect(t.nextStep).not.toContain('Full output');
    });

    it('SUCCEEDED with items but no fields metadata omits the fields hint without a dangling em-dash', () => {
        const dataset: RunDataset = { id: 'ds-1', itemCount: 5, fields: [] };
        const t = buildStatusSummaryNextStep({ run: makeRun('SUCCEEDED'), dataset });
        expect(t.nextStep).toContain('get-dataset-items');
        expect(t.nextStep).not.toContain('Available fields');
        expect(t.nextStep).not.toContain('—');
    });

    it('SUCCEEDED with empty dataset + KV records: nextStep points at dataset, not KV', () => {
        const t = buildStatusSummaryNextStep({
            run: makeRun('SUCCEEDED'),
            dataset: datasetEmpty,
            keyValueStore: kvWithRecords,
        });
        expect(t.summary).toContain('No dataset items found');
        expect(t.summary).toContain('Key-value store has 2 keys');
        expect(t.nextStep).toContain('get-dataset-items');
        expect(t.nextStep).toContain('datasetId=ds-1');
        expect(t.nextStep).not.toContain('get-key-value-store-record');
    });

    it('SUCCEEDED with neither dataset items nor KV records routes to "no output" nextStep', () => {
        const t = buildStatusSummaryNextStep({ run: makeRun('SUCCEEDED') });
        expect(t.summary).toContain('No dataset items found');
        expect(t.summary).not.toContain('Key-value store');
        expect(t.nextStep).toContain('re-run');
    });

    it('SUCCEEDED with both dataset items and KV records picks dataset for nextStep, mentions both in summary', () => {
        const t = buildStatusSummaryNextStep({
            run: makeRun('SUCCEEDED'),
            dataset: datasetWithItems,
            keyValueStore: kvWithRecords,
        });
        expect(t.summary).toContain('47 items; 2 fields available');
        expect(t.summary).toContain('Key-value store has 2 keys');
        expect(t.nextStep).toContain('get-dataset-items');
        expect(t.nextStep).not.toContain('get-key-value-store-record');
    });

    it('SUCCEEDED with truncated key-value store reports partial count, not exact 50', () => {
        const truncatedKv: RunKeyValueStore = {
            id: 'kv-1',
            keys: Array.from({ length: 50 }, (_, i) => `k-${i}`),
            // keyCount intentionally omitted — buildKeyValueStoreBlock omits it on truncation.
        };
        const t = buildStatusSummaryNextStep({
            run: makeRun('SUCCEEDED'),
            dataset: datasetEmpty,
            keyValueStore: truncatedKv,
        });
        expect(t.summary).toContain('at least 50 keys');
        expect(t.summary).not.toMatch(/\(50 keys\)/);
    });

    it('TIMED-OUT with dataset routes to partial-output nextStep', () => {
        const t = buildStatusSummaryNextStep({
            run: makeRun('TIMED-OUT'),
            dataset: datasetWithItems,
        });
        expect(t.nextStep).toContain('partial output (47 items written)');
    });

    it('TIMED-OUT with both dataset and KV records picks dataset for nextStep', () => {
        const t = buildStatusSummaryNextStep({
            run: makeRun('TIMED-OUT'),
            dataset: datasetWithItems,
            keyValueStore: kvWithRecords,
        });
        expect(t.summary).toContain('Key-value store has 2 keys');
        expect(t.nextStep).toContain('partial output (47 items written)');
        expect(t.nextStep).not.toContain('get-key-value-store-record');
    });

    it('TIMED-OUT without dataset routes to "no dataset to fetch" nextStep', () => {
        const t = buildStatusSummaryNextStep({ run: makeRun('TIMED-OUT') });
        expect(t.nextStep).toContain('no dataset to fetch');
    });

    // ---- statusMessage attribution + double-period invariants ----
    // The upstream statusMessage can be stale relative to elapsedSecs and often arrives with a
    // trailing period. We always render it as ` Actor status: "..."` (no double period) so a
    // naive reader doesn't mistake the actor's own message for our narrative.

    it('RUNNING with upstream statusMessage attributes it as Actor status and drops trailing period', () => {
        const t = buildStatusSummaryNextStep({
            run: makeRun('RUNNING', 'Starting the crawler.'),
        });
        expect(t.summary).toContain('Actor status: "Starting the crawler"');
        expect(t.summary).not.toMatch(/\.\./);
    });

    it('RUNNING without statusMessage falls back to In progress (no Actor status attribution)', () => {
        const t = buildStatusSummaryNextStep({ run: makeRun('RUNNING') });
        expect(t.summary).toContain('In progress.');
        expect(t.summary).not.toContain('Actor status:');
    });

    it('RUNNING with dataset items appends "N results so far" so polling agents see real progress', () => {
        const t = buildStatusSummaryNextStep({
            run: makeRun('RUNNING'),
            dataset: datasetWithItems,
        });
        expect(t.summary).toContain('47 results so far.');
        // Progress is summary-only; nextStep stays poll-only — partial reads mid-run are noise.
        expect(t.nextStep).toContain('poll for completion');
        expect(t.nextStep).not.toContain('get-dataset-items');
    });

    it('RUNNING with empty dataset omits the progress suffix (no "0 results so far")', () => {
        const t = buildStatusSummaryNextStep({
            run: makeRun('RUNNING'),
            dataset: datasetEmpty,
        });
        expect(t.summary).not.toMatch(/results so far/);
        expect(t.summary).not.toContain('0 results');
    });

    it('RUNNING with exactly 1 item uses singular "result"', () => {
        const t = buildStatusSummaryNextStep({
            run: makeRun('RUNNING'),
            dataset: { id: 'ds-1', itemCount: 1 },
        });
        expect(t.summary).toContain('1 result so far.');
        expect(t.summary).not.toContain('results');
    });

    it('TIMING-OUT with dataset items surfaces progress in the summary', () => {
        const t = buildStatusSummaryNextStep({
            run: makeRun('TIMING-OUT'),
            dataset: datasetWithItems,
        });
        expect(t.summary).toContain('47 results so far.');
    });

    it('ABORTING with dataset items surfaces progress in the summary', () => {
        const t = buildStatusSummaryNextStep({
            run: makeRun('ABORTING'),
            dataset: datasetWithItems,
        });
        expect(t.summary).toContain('47 results so far.');
    });

    it('SUCCEEDED with 0 items surfaces the upstream statusMessage attributed in the summary', () => {
        // The agent reading text-only must see the actor's diagnostic; we pass it through with
        // attribution so it's clear the wording is upstream, not ours.
        const run = makeRun('SUCCEEDED', 'Finished! Total 1 requests: 1 succeeded, 0 failed.');
        const t = buildStatusSummaryNextStep({ run, dataset: datasetEmpty });
        expect(t.summary).toContain('Actor status: "Finished! Total 1 requests: 1 succeeded, 0 failed"');
        expect(t.summary).not.toMatch(/\.\./);
    });

    it('SUCCEEDED with items ends nextStep with a single period after the fields hint', () => {
        // Pinned to prevent the `to project..` regression: the fields-hint template already
        // terminates the sentence, so the outer nextStep template must not append its own `.`.
        const t = buildStatusSummaryNextStep({
            run: makeRun('SUCCEEDED'),
            dataset: datasetWithItems,
        });
        expect(t.nextStep).toMatch(/to project\.$/);
        expect(t.nextStep).not.toMatch(/\.\.$/);
    });
});

// -----------------------------------------------------------------------------
// collapseArrayIndices (#894): the single boundary where Apify's index-expanded
// `dataset.fields` is normalized. `buildRunDataset` calls this once, so every
// downstream consumer (structured `storages.datasets.default.fields` AND the
// narrative summary/nextStep) sees a flat deduped list.
// -----------------------------------------------------------------------------
describe('collapseArrayIndices', () => {
    it('strips numeric segments and dedupes paths sharing the same shape', () => {
        expect(
            collapseArrayIndices([
                'latestComments.0.id',
                'latestComments.0.text',
                'latestComments.1.id',
                'latestComments.1.text',
                'latestComments.2.owner.username',
            ]),
        ).toEqual(['latestComments.id', 'latestComments.text', 'latestComments.owner.username']);
    });

    it('preserves non-array fields unchanged and preserves first-occurrence order', () => {
        expect(
            collapseArrayIndices(['metadata.url', 'entities.hashtags.0.text', 'entities.hashtags.1.text', 'markdown']),
        ).toEqual(['metadata.url', 'entities.hashtags.text', 'markdown']);
    });

    it('returns [] for empty input', () => {
        expect(collapseArrayIndices([])).toEqual([]);
    });

    it('drops paths that collapse to empty (pathological all-numeric segments)', () => {
        // Pure-numeric top-level keys are pathological (dataset fields are object keys, not
        // array indices) but we still don't want them sneaking through as empty strings.
        expect(collapseArrayIndices(['0', '1', '2'])).toEqual([]);
    });
});
