import { describe, expect, it } from 'vitest';

import {
    buildStatusTemplate,
    type CanonicalRunDataset,
    type CanonicalRunKeyValueStore,
    type CanonicalRunResponse,
} from '../../src/tools/core/get_actor_run_common.js';
import { defaultGetActorRun } from '../../src/tools/default/get_actor_run.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';

/**
 * Default mode `get-actor-run` returns the v4 canonical shape:
 * responseVersion, runId, actorId, status, storages, summary, nextStep — with no inlined
 * dataset items or KV record bodies. Tests cover all 8 status templates plus shape invariants.
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
    listItemsProbe?: { items: unknown[] };
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
    it('returns canonical v4 shape for a SUCCEEDED run with dataset items', async () => {
        const run = mockSucceededRun();
        const result = await (defaultGetActorRun as HelperTool).call(
            callArgs(stubClient({ run, dataset: mockDataset() }), { runId: 'run-1', waitSecs: 0 }),
        );

        const { structuredContent, content, _meta } = result as {
            structuredContent: CanonicalRunResponse;
            content: { type: string; text: string }[];
            _meta?: Record<string, unknown>;
        };

        expect(structuredContent.responseVersion).toBe('v4');
        expect(structuredContent.runId).toBe('run-1');
        expect(structuredContent.actorId).toBe('actor-id-1');
        expect(structuredContent.actorName).toBe('apify/rag-web-browser');
        expect(structuredContent.status).toBe('SUCCEEDED');
        expect(structuredContent.exitCode).toBe(0);
        expect(structuredContent.stats).toEqual({ runTimeSecs: 22, computeUnits: 0.04, memMaxBytes: 268435456 });

        // Slash-to-dot translation on dataset.fields.
        expect(structuredContent.storages.dataset?.id).toBe('dataset-xyz');
        expect(structuredContent.storages.dataset?.fields).toEqual(['crawl.httpStatusCode', 'metadata.url', 'markdown']);
        expect(structuredContent.storages.dataset?.itemCount).toBe(47);
        expect(structuredContent.storages.keyValueStore?.id).toBe('kv-xyz');

        // No inlined item bodies anywhere on the response.
        const dump = JSON.stringify(structuredContent);
        expect(dump).not.toContain('previewItems');
        expect(dump).not.toContain('"items":');

        // Text content carries summary + nextStep with identifiers — no JSON code fence.
        expect(content).toHaveLength(1);
        expect(content[0].text).toContain('SUCCEEDED in 22s');
        expect(content[0].text).toContain('dataset-xyz');
        expect(content[0].text).not.toContain('```json');

        // Usage attribution `_meta` is preserved.
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
        const { structuredContent } = result as { structuredContent: CanonicalRunResponse };

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
        const result = await (defaultGetActorRun as HelperTool).call(
            callArgs(
                stubClient({ run, dataset, listItemsProbe: { items: [{ a: 1 }, { a: 2 }, { a: 3 }] } }),
                { runId: 'run-1', waitSecs: 0 },
            ),
        );
        const { structuredContent } = result as { structuredContent: CanonicalRunResponse };
        expect(structuredContent.storages.dataset?.itemCount).toBe(3);
    });

    it('rejects waitSecs above 45', () => {
        const tool = defaultGetActorRun as HelperTool;
        // AJV strips/coerces — `runId` valid, `waitSecs: 46` violates max.
        const ok = tool.ajvValidate({ runId: 'run-1', waitSecs: 46 });
        expect(ok).toBe(false);
    });

    it('rejects waitSecs below 0', () => {
        const tool = defaultGetActorRun as HelperTool;
        const ok = tool.ajvValidate({ runId: 'run-1', waitSecs: -1 });
        expect(ok).toBe(false);
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
    } as Parameters<typeof buildStatusTemplate>[0]['run'];
}

const datasetWithItems: CanonicalRunDataset = { id: 'ds-1', itemCount: 47, fields: ['metadata.url', 'markdown'] };
const datasetEmpty: CanonicalRunDataset = { id: 'ds-1', itemCount: 0, fields: [] };
const kvWithOutput: CanonicalRunKeyValueStore = { id: 'kv-1', keys: ['OUTPUT', 'log.txt'], keyCount: 2 };
const kvWithoutOutput: CanonicalRunKeyValueStore = { id: 'kv-1', keys: ['result-a', 'result-b'], keyCount: 2 };

describe('buildStatusTemplate', () => {
    it('READY', () => {
        const t = buildStatusTemplate({ run: makeRun('READY') });
        expect(t.summary).toMatch(/^READY\. Run run-X was created/);
        expect(t.nextStep).toContain('runId=run-X');
        expect(t.nextStep).toContain('waitSecs=10');
    });

    it('RUNNING uses statusMessage when present', () => {
        const t = buildStatusTemplate({ run: makeRun('RUNNING', 'Crawling page 5/20') });
        expect(t.summary).toContain('Crawling page 5/20');
        expect(t.nextStep).toContain('poll for completion');
    });

    it('TIMING-OUT', () => {
        const t = buildStatusTemplate({ run: makeRun('TIMING-OUT') });
        expect(t.summary).toMatch(/^TIMING-OUT after /);
        expect(t.nextStep).toContain('observe terminal state');
    });

    it('ABORTING', () => {
        const t = buildStatusTemplate({ run: makeRun('ABORTING') });
        expect(t.summary).toMatch(/^ABORTING after /);
        expect(t.nextStep).toContain('observe terminal state');
    });

    it('SUCCEEDED with dataset items', () => {
        const t = buildStatusTemplate({ run: makeRun('SUCCEEDED'), dataset: datasetWithItems });
        expect(t.summary).toMatch(/^SUCCEEDED in 10s\. 47 items; 2 fields available\.$/);
        expect(t.nextStep).toContain('get-dataset-items');
        expect(t.nextStep).toContain('datasetId=ds-1');
        expect(t.nextStep).toContain('metadata.url, markdown');
    });

    it('SUCCEEDED, dataset empty + KV with OUTPUT key', () => {
        const t = buildStatusTemplate({ run: makeRun('SUCCEEDED'), dataset: datasetEmpty, keyValueStore: kvWithOutput });
        expect(t.summary).toContain('Output written to key-value store');
        expect(t.nextStep).toContain('get-key-value-store-record');
        expect(t.nextStep).toContain('keyValueStoreId=kv-1');
        expect(t.nextStep).toContain('recordKey="OUTPUT"');
        expect(t.nextStep).toContain('Other keys: log.txt');
    });

    it('SUCCEEDED, dataset empty + KV without OUTPUT key', () => {
        const t = buildStatusTemplate({ run: makeRun('SUCCEEDED'), dataset: datasetEmpty, keyValueStore: kvWithoutOutput });
        expect(t.nextStep).toContain('one of these keys (as recordKey): result-a, result-b');
    });

    it('SUCCEEDED with no output at all', () => {
        const t = buildStatusTemplate({ run: makeRun('SUCCEEDED') });
        expect(t.summary).toContain('No dataset items and no key-value records');
        expect(t.nextStep).toContain('re-run');
    });

    it('FAILED', () => {
        const t = buildStatusTemplate({ run: makeRun('FAILED', 'Out of memory') });
        expect(t.summary).toBe('FAILED after 10s: Out of memory.');
        expect(t.nextStep).toContain('exitCode');
    });

    it('ABORTED', () => {
        const t = buildStatusTemplate({ run: makeRun('ABORTED') });
        expect(t.summary).toBe('ABORTED after 10s.');
        expect(t.nextStep).toContain('rerun');
    });

    it('TIMED-OUT with dataset', () => {
        const t = buildStatusTemplate({ run: makeRun('TIMED-OUT'), dataset: datasetWithItems });
        expect(t.summary).toBe('TIMED-OUT after 10s.');
        expect(t.nextStep).toContain('partial output (47 items written)');
    });

    it('TIMED-OUT without dataset', () => {
        const t = buildStatusTemplate({ run: makeRun('TIMED-OUT') });
        expect(t.summary).toBe('TIMED-OUT after 10s.');
        expect(t.nextStep).toContain('no dataset to fetch');
    });
});
