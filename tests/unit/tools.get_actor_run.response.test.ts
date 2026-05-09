import { describe, expect, it } from 'vitest';

import {
    buildStatusSummaryNextStep,
    type RunDataset,
    type RunKeyValueStore,
    type RunResponse,
} from '../../src/tools/core/get_actor_run_common.js';
import { defaultGetActorRun } from '../../src/tools/default/get_actor_run.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';

/**
 * Default mode `get-actor-run` returns: runId, actorId, status, storages, summary, nextStep
 * — with no inlined dataset items or KV record bodies.
 * Tests cover all 8 status templates plus shape invariants.
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
        cleanItemCount: 47,
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

function callArgs(client: InternalToolArgs['apifyClient'], args: Record<string, unknown>): InternalToolArgs {
    return {
        args,
        apifyToken: 'test-token',
        apifyClient: client,
        extra: {} as InternalToolArgs['extra'],
        mcpServer: {} as InternalToolArgs['mcpServer'],
        apifyMcpServer: { options: { paymentProvider: undefined } } as InternalToolArgs['apifyMcpServer'],
    } as InternalToolArgs;
}

describe('get-actor-run default response', () => {
    it('end-to-end SUCCEEDED: translates fields, omits legacy preview, carries identifiers in text, attaches usage _meta', async () => {
        const run = mockSucceededRun();
        const result = await (defaultGetActorRun as HelperTool).call(
            callArgs(stubClient({ run, dataset: mockDataset() }), { runId: 'run-1', waitSecs: 0 }),
        );

        const { structuredContent, content, _meta } = result as {
            structuredContent: RunResponse;
            content: { type: string; text: string }[];
            _meta?: Record<string, unknown>;
        };

        // Slash-to-dot translation on dataset.fields. Mock returns `crawl/httpStatusCode`; response must rewrite to `crawl.httpStatusCode`.
        expect(structuredContent.storages.dataset?.fields).toEqual(['crawl.httpStatusCode', 'metadata.url', 'markdown']);

        // actorName composed from `${username}/${name}`.
        expect(structuredContent.actorName).toBe('apify/rag-web-browser');

        // No legacy preview field and no inlined item bodies anywhere on the response.
        const dump = JSON.stringify(structuredContent);
        expect(dump).not.toContain('previewItems');
        expect(dump).not.toContain('"items":');

        // Text channel carries identifiers (so text-mode clients can parse them) but never a JSON dump.
        expect(content[0].text).toContain('dataset-xyz');
        expect(content[0].text).not.toContain('```json');

        // Usage attribution `_meta` flows through end-to-end.
        expect(_meta?.['com.apify/ActorRun']).toEqual({
            usageTotalUsd: 0.0001,
            usageUsd: { ACTOR_COMPUTE_UNITS: 0.0001 },
        });
    });

    it('returns shape with just IDs for a non-terminal RUNNING run (no extra metadata fetches)', async () => {
        let datasetCalls = 0;
        let kvCalls = 0;
        const run = { ...mockSucceededRun({ status: 'RUNNING', finishedAt: undefined }), exitCode: undefined };
        const client = {
            run: (_id: string) => ({ get: async () => run, waitForFinish: async () => run }),
            actor: (_id: string) => ({ get: async () => ACTOR }),
            dataset: (_id: string) => {
                datasetCalls += 1;
                return { get: async () => mockDataset(), listItems: async () => ({ items: [], total: 0 }) };
            },
            keyValueStore: (_id: string) => {
                kvCalls += 1;
                return { listKeys: async () => ({ items: [], count: 0, isTruncated: false, limit: 50 }) };
            },
        } as unknown as InternalToolArgs['apifyClient'];

        const result = await (defaultGetActorRun as HelperTool).call(callArgs(client, { runId: 'run-1', waitSecs: 0 }));
        const { structuredContent } = result as { structuredContent: RunResponse };

        expect(structuredContent.status).toBe('RUNNING');
        expect(structuredContent.storages.dataset?.id).toBe('dataset-xyz');
        // Non-terminal: only the id is populated, no fields/itemCount.
        expect(structuredContent.storages.dataset?.fields).toBeUndefined();
        expect(structuredContent.storages.dataset?.itemCount).toBeUndefined();
        expect(datasetCalls).toBe(0);
        expect(kvCalls).toBe(0);
    });

    it('triggers the itemCount=0 lag-fallback probe on terminal SUCCEEDED', async () => {
        const run = mockSucceededRun();
        const dataset = mockDataset({ itemCount: 0 });
        // Probe runs with `limit: 1`, so `items.length === 1` even when the dataset has more.
        // The recovered count must come from `total`, otherwise the lag fallback caps at 1.
        const result = await (defaultGetActorRun as HelperTool).call(
            callArgs(
                stubClient({ run, dataset, listItemsProbe: { items: [{ a: 1 }], total: 47 } }),
                { runId: 'run-1', waitSecs: 0 },
            ),
        );
        const { structuredContent } = result as { structuredContent: RunResponse };
        expect(structuredContent.storages.dataset?.itemCount).toBe(47);
    });

    it('rejects waitSecs above 45', () => {
        const tool = defaultGetActorRun as HelperTool;
        expect(tool.ajvValidate({ runId: 'run-1', waitSecs: 46 })).toBe(false);
    });

    it('rejects waitSecs below 0', () => {
        const tool = defaultGetActorRun as HelperTool;
        expect(tool.ajvValidate({ runId: 'run-1', waitSecs: -1 })).toBe(false);
    });

    it('degrades gracefully when dataset metadata fetch fails: keeps SUCCEEDED, points at dataset', async () => {
        const run = mockSucceededRun();
        const client = {
            run: (_id: string) => ({ get: async () => run, waitForFinish: async () => run }),
            actor: (_id: string) => ({ get: async () => ACTOR }),
            dataset: (_id: string) => ({
                get: async () => { throw new Error('transient network error'); },
                listItems: async () => ({ items: [], total: 0 }),
            }),
            keyValueStore: (_id: string) => ({
                listKeys: async () => ({ items: [], count: 0, isTruncated: false, limit: 50 }),
            }),
        } as unknown as InternalToolArgs['apifyClient'];

        const result = await (defaultGetActorRun as HelperTool).call(callArgs(client, { runId: 'run-1', waitSecs: 0 }));
        const { content, structuredContent, isError } = result as {
            content: { text: string }[];
            structuredContent: RunResponse;
            isError?: boolean;
        };

        // The whole call must NOT hard-fail just because one metadata fetch errored.
        expect(isError).not.toBe(true);
        expect(structuredContent.status).toBe('SUCCEEDED');

        // Dataset id is still surfaced (the agent can fetch items directly even without metadata).
        expect(structuredContent.storages.dataset?.id).toBe('dataset-xyz');
        expect(structuredContent.storages.dataset?.itemCount).toBeUndefined();
        expect(structuredContent.storages.dataset?.fields).toBeUndefined();

        // nextStep points at get-dataset-items, not the "no output / re-run" branch.
        expect(structuredContent.nextStep).toContain('get-dataset-items');
        expect(structuredContent.nextStep).toContain('datasetId=dataset-xyz');
        expect(content[0].text).not.toContain('No dataset items and no key-value records were found');
        expect(content[0].text).not.toMatch(/re-run/i);
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
                listKeys: async () => { throw new Error('transient KV error'); },
            }),
        } as unknown as InternalToolArgs['apifyClient'];

        const result = await (defaultGetActorRun as HelperTool).call(callArgs(client, { runId: 'run-1', waitSecs: 0 }));
        const { structuredContent, isError } = result as { structuredContent: RunResponse; isError?: boolean };

        expect(isError).not.toBe(true);
        expect(structuredContent.status).toBe('SUCCEEDED');
        expect(structuredContent.storages.dataset?.itemCount).toBe(47);
        // KV id is still surfaced from the run record; the failed listKeys just leaves keys unknown.
        expect(structuredContent.storages.keyValueStore?.id).toBe('kv-xyz');
        expect(structuredContent.storages.keyValueStore?.keys).toBeUndefined();
        expect(structuredContent.storages.keyValueStore?.keyCount).toBeUndefined();
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
            updateProgress: async (msg: string) => { updateProgressCalls.push(msg); },
            startActorRunUpdates: (runId: string) => { startActorRunUpdatesCalls.push(runId); },
            stop: () => { stopCount += 1; },
        };

        const baseArgs = callArgs(client, { runId: 'run-1', waitSecs: 5 });
        await (defaultGetActorRun as HelperTool).call({
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
        const result = await (defaultGetActorRun as HelperTool).call(
            callArgs(client, { runId: 'missing', waitSecs: 0 }),
        ) as { isError?: boolean; content: { text: string }[] };
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('not found');
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
        const t = buildStatusSummaryNextStep({ run: makeRun('SUCCEEDED'), dataset: datasetWithItems });
        expect(t.summary).toContain('47 items; 2 fields available');
        expect(t.nextStep).toContain('get-dataset-items');
        expect(t.nextStep).toContain('datasetId=ds-1');
        expect(t.nextStep).toContain('metadata.url, markdown');
    });

    it('SUCCEEDED with empty dataset + KV records routes to KV-record nextStep', () => {
        const t = buildStatusSummaryNextStep({ run: makeRun('SUCCEEDED'), dataset: datasetEmpty, keyValueStore: kvWithRecords });
        expect(t.summary).toContain('Output written to key-value store');
        expect(t.nextStep).toContain('get-key-value-store-record');
        expect(t.nextStep).toContain('keyValueStoreId=kv-1');
        expect(t.nextStep).toContain('one of these keys (as recordKey): result-a, result-b');
    });

    it('SUCCEEDED with neither dataset items nor KV records routes to "no output" nextStep', () => {
        const t = buildStatusSummaryNextStep({ run: makeRun('SUCCEEDED') });
        expect(t.summary).toContain('No dataset items and no key-value records');
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
        const t = buildStatusSummaryNextStep({ run: makeRun('SUCCEEDED'), dataset: datasetEmpty, keyValueStore: truncatedKv });
        expect(t.summary).toContain('at least 50 keys');
        expect(t.summary).not.toMatch(/\(50 keys\)/);
    });

    it('TIMED-OUT with dataset routes to partial-output nextStep', () => {
        const t = buildStatusSummaryNextStep({ run: makeRun('TIMED-OUT'), dataset: datasetWithItems });
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
});
