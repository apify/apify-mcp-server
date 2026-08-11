import type { LangfuseClient } from '@langfuse/client';
import { describe, expect, it } from 'vitest';

import {
    type DatasetItem,
    parseWorkflowItem,
    resolveDatasetName,
    syncDataset,
    WORKFLOW_DATASET_NAME,
} from '../../evals/workflows/langfuse_dataset.js';
import { DEFAULT_TEST_CASES_PATH, type WorkflowTestCase } from '../../evals/workflows/test_cases_loader.js';

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
    it('uses the canonical dataset for the default test cases file', () => {
        expect(resolveDatasetName(DEFAULT_TEST_CASES_PATH)).toBe(WORKFLOW_DATASET_NAME);
    });

    it('derives a separate dataset for a custom file so the shared one is never overwritten', () => {
        expect(resolveDatasetName('/tmp/scratch.json')).toMatch(
            new RegExp(`^${WORKFLOW_DATASET_NAME}-scratch-[0-9a-f]{8}$`),
        );
    });

    it('keeps same-named files in different directories apart', () => {
        expect(resolveDatasetName('/tmp/a/scratch.json')).not.toBe(resolveDatasetName('/tmp/b/scratch.json'));
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
        await syncDataset(client, WORKFLOW_DATASET_NAME, [{ ...testCase, maxTurns: 3, tools: ['actors'] }]);

        expect(datasets).toEqual([WORKFLOW_DATASET_NAME]);
        expect(created).toEqual([
            {
                datasetName: WORKFLOW_DATASET_NAME,
                id: 'search-001',
                input: { query: 'q' },
                expectedOutput: 'r',
                metadata: { category: 'search', maxTurns: 3, tools: ['actors'] },
            },
        ]);
    });

    it('namespaces the ids it upserts into a scratch dataset, since ids cannot be reused across datasets', async () => {
        const { client, created } = makeLangfuseClient();
        const items = await syncDataset(client, 'scratch', [testCase]);

        expect(created[0].id).toBe('scratch:search-001');
        // Keyed by test case id, so no caller has to re-derive the namespacing rule.
        expect(items.get('search-001')?.id).toBe('scratch:search-001');
    });

    it('returns the created items so the caller never re-fetches the dataset', async () => {
        const { client } = makeLangfuseClient();
        const items = await syncDataset(client, WORKFLOW_DATASET_NAME, [testCase, { ...testCase, id: 'search-002' }]);

        expect([...items.keys()]).toEqual(['search-001', 'search-002']);
        expect([...items.values()].every((item) => item.datasetId === 'ds-1')).toBe(true);
    });
});
