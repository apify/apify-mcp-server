import type { LangfuseClient } from '@langfuse/client';
import { describe, expect, it } from 'vitest';

import {
    type DatasetItem,
    parseWorkflowItem,
    resolveDatasetName,
    syncDataset,
    WORKFLOW_DATASET_NAME,
} from '../../evals/workflows/langfuse_dataset.js';
import type { WorkflowTestCase } from '../../evals/workflows/test_cases_loader.js';

const testCase: WorkflowTestCase = { id: 'search-001', category: 'search', query: 'q', reference: 'r' };

/** Langfuse client that records upserts and echoes them back like the real API. */
function makeLangfuseClient() {
    const created: Record<string, unknown>[] = [];
    const datasets: string[] = [];
    const client = {
        api: { datasets: { create: async ({ name }: { name: string }) => void datasets.push(name) } },
        dataset: {
            createItem: async (request: Record<string, unknown>) => {
                created.push(request);
                return { ...request, datasetId: 'ds-1' } as unknown as DatasetItem;
            },
        },
    } as unknown as LangfuseClient;
    return { client, created, datasets };
}

describe('resolveDatasetName()', () => {
    it('uses the canonical dataset when no test cases path is given', () => {
        expect(resolveDatasetName()).toBe(WORKFLOW_DATASET_NAME);
    });

    it('derives a separate dataset for a custom file so the shared one is never overwritten', () => {
        expect(resolveDatasetName('/tmp/scratch.json')).toBe(`${WORKFLOW_DATASET_NAME}-scratch`);
    });
});

describe('parseWorkflowItem()', () => {
    const item = { id: 'a', input: { query: 'q' }, expectedOutput: 'r', metadata: { category: 'search' } };

    it('returns the fields a run reads', () => {
        expect(parseWorkflowItem(item)).toEqual(item);
    });

    it('keeps the optional harness knobs from metadata', () => {
        const withKnobs = { ...item, metadata: { category: 'search', maxTurns: 5, failTools: ['call-actor'] } };
        expect(parseWorkflowItem(withKnobs).metadata).toEqual(withKnobs.metadata);
    });

    it('throws naming the item when metadata was cleared', () => {
        expect(() => parseWorkflowItem({ ...item, metadata: undefined })).toThrow(/Dataset item "a"/);
    });

    it('throws when the query or the reference is empty', () => {
        expect(() => parseWorkflowItem({ ...item, input: { query: '' } })).toThrow(/not a usable workflow test case/);
        expect(() => parseWorkflowItem({ ...item, expectedOutput: '' })).toThrow(/not a usable workflow test case/);
    });

    it('reports an unknown id when the item is not an object', () => {
        expect(() => parseWorkflowItem(null)).toThrow(/Dataset item "\(unknown\)"/);
    });
});

describe('syncDataset()', () => {
    it('upserts each test case by id, splitting query, reference and harness knobs', async () => {
        const { client, created, datasets } = makeLangfuseClient();
        await syncDataset(client, 'scratch', [{ ...testCase, maxTurns: 3, tools: ['actors'] }]);

        expect(datasets).toEqual(['scratch']);
        expect(created).toEqual([
            {
                datasetName: 'scratch',
                id: 'search-001',
                input: { query: 'q' },
                expectedOutput: 'r',
                metadata: { category: 'search', maxTurns: 3, tools: ['actors'] },
            },
        ]);
    });

    it('returns the created items so the caller never re-fetches the dataset', async () => {
        const { client } = makeLangfuseClient();
        const items = await syncDataset(client, 'scratch', [testCase, { ...testCase, id: 'search-002' }]);

        expect(items.map((item) => item.id)).toEqual(['search-001', 'search-002']);
        expect(items.every((item) => item.datasetId === 'ds-1')).toBe(true);
    });
});
