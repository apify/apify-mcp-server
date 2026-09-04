#!/usr/bin/env node
/* eslint-disable */
/**
 * SPIKE (throwaway) — Q2: how does @langfuse/client's experiment.run() handle running
 * each dataset item N times (for --iterations / pass@k / pass^k)?
 *
 * Phase 1: trivial no-LLM task, dataset `zz-spike-selection-poc` (items `spike/*`), each
 * item repeated N=3 times in `data` with the SAME runName, to see whether:
 *  - all N task() calls execute and get their own trace + scores (they should - scores are
 *    attached by traceId, not by dataset-run-item)
 *  - the dataset-run-item linkage (POST /api/public/dataset-run-items, keyed by
 *    (runName, datasetItemId)) succeeds N times or only once
 *  - GET /api/public/experiments and the dataset-run detail reflect N item-results or 1
 *
 * Phase 2: same probe but with the real agent (deny-all, tiny maxTurns) for 2 items x 2
 * iterations, to confirm the same shape holds under the real task function.
 */
import 'dotenv/config';
import { LangfuseClient } from '@langfuse/client';

import { initTracing, shutdownTracing } from '../langfuse_tracing.js';

const DATASET_NAME = 'zz-spike-selection-poc';

async function ensureDataset(langfuse: LangfuseClient) {
    try {
        await langfuse.api.datasets.get(DATASET_NAME);
        console.log(`dataset "${DATASET_NAME}" already exists`);
    } catch {
        await langfuse.api.datasets.create({ name: DATASET_NAME, description: 'THROWAWAY spike for #260 iterations probe. Safe to archive/delete.' });
        console.log(`created dataset "${DATASET_NAME}"`);
    }

    const items = [
        { id: 'spike/item-1', input: { query: 'q1' }, expectedOutput: 'a1' },
        { id: 'spike/item-2', input: { query: 'q2' }, expectedOutput: 'a2' },
    ];
    for (const it of items) {
        try {
            await langfuse.createDatasetItem({ datasetName: DATASET_NAME, ...it });
            console.log(`created item ${it.id}`);
        } catch (e) {
            console.log(`item ${it.id} likely exists already: ${(e as Error).message}`);
        }
    }
}

async function main() {
    initTracing();
    const langfuse = new LangfuseClient();
    await ensureDataset(langfuse);

    const dataset = await langfuse.dataset.get(DATASET_NAME, { fetchItemsPageSize: 100 });
    const activeItems = dataset.items.filter((i) => i.status === 'ACTIVE');
    console.log(`active items: ${activeItems.map((i) => i.id).join(', ')}`);

    const ITERATIONS = 3;
    // The naive approach #260 might try: repeat each item N times in the data array.
    const repeated = activeItems.flatMap((item) => Array.from({ length: ITERATIONS }, () => item));
    console.log(`data array length (items x iterations) = ${repeated.length}`);

    let counter = 0;
    const runName = `spike-iter-probe-${Date.now()}`;
    const result = await langfuse.experiment.run({
        name: DATASET_NAME,
        runName,
        description: 'THROWAWAY spike probe for #260 --iterations semantics.',
        data: repeated,
        task: async (item: any) => {
            const n = counter++;
            // No LLM call: canned output, but distinguishable per call so we can tell
            // whether N separate task executions actually happened.
            return { canned: true, callIndex: n, itemId: item.id, echo: item.input };
        },
        evaluators: [
            async ({ output }) => ({ name: 'spike_call_index', value: (output as any).callIndex }),
        ],
        maxConcurrency: 4,
    });

    console.log('\n=== experiment.run() result (Phase 1: fake task, same item repeated in data[]) ===');
    console.log('runName:', result.runName);
    console.log('experimentId:', result.experimentId);
    console.log('datasetRunId:', result.datasetRunId);
    console.log('datasetRunUrl:', result.datasetRunUrl);
    console.log('itemResults.length:', result.itemResults.length);
    for (const r of result.itemResults) {
        console.log(' -', JSON.stringify({ id: (r.item as any).id, traceId: r.traceId, datasetRunId: r.datasetRunId, output: r.output }));
    }

    await langfuse.flush();
    await shutdownTracing();

    // Query the dataset-run-items REST endpoint directly for this run name, to see how many
    // rows actually landed server-side per (runName, datasetItemId).
    const base = process.env.LANGFUSE_BASE_URL;
    const auth = Buffer.from(`${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`).toString('base64');
    const runsResp = await fetch(`${base}/api/public/dataset-run-items?datasetId=${dataset.id}&limit=50`, {
        headers: { Authorization: `Basic ${auth}` },
    });
    console.log('\n=== GET /api/public/dataset-run-items?datasetId=... (status', runsResp.status, ') ===');
    const runsJson = await runsResp.json().catch(() => undefined);
    console.log(JSON.stringify(runsJson, null, 2)?.slice(0, 4000));

    const runDetailResp = await fetch(`${base}/api/public/datasets/${encodeURIComponent(DATASET_NAME)}/runs/${encodeURIComponent(runName)}`, {
        headers: { Authorization: `Basic ${auth}` },
    });
    console.log('\n=== GET /api/public/datasets/<name>/runs/<runName> (status', runDetailResp.status, ') ===');
    console.log((await runDetailResp.text()).slice(0, 4000));

    const fromStartTime = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const toStartTime = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const expResp = await fetch(`${base}/api/public/experiments?fromStartTime=${fromStartTime}&toStartTime=${toStartTime}&limit=20`, {
        headers: { Authorization: `Basic ${auth}` },
    });
    console.log('\n=== GET /api/public/experiments (status', expResp.status, ') ===');
    console.log((await expResp.text()).slice(0, 6000));
}

void main();
