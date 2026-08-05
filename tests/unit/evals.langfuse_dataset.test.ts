import { describe, expect, it } from 'vitest';

import {
    selectDatasetItems,
    testCaseToDatasetItem,
    WORKFLOW_DATASET_NAME,
} from '../../evals/workflows/langfuse_dataset.js';
import type { WorkflowTestCase } from '../../evals/workflows/test_cases_loader.js';

describe('testCaseToDatasetItem()', () => {
    it('uses the test case id as the item id for idempotent upsert', () => {
        const testCase: WorkflowTestCase = { id: 'search-001', category: 'search', query: 'q', reference: 'r' };
        const item = testCaseToDatasetItem(testCase);
        expect(item.datasetName).toBe(WORKFLOW_DATASET_NAME);
        expect(item.id).toBe('search-001');
        expect(item.input).toEqual({ query: 'q' });
        expect(item.expectedOutput).toBe('r');
    });

    it('uses null expectedOutput when there is no reference', () => {
        const testCase: WorkflowTestCase = { id: 'a', category: 'basic', query: 'q' };
        expect(testCaseToDatasetItem(testCase).expectedOutput).toBeNull();
    });

    it('carries the whole test case in metadata so the task can run off the item', () => {
        const testCase: WorkflowTestCase = {
            id: 'a',
            category: 'basic',
            query: 'q',
            maxTurns: 5,
            tools: ['actors'],
            failTools: ['call-actor'],
        };
        expect(testCaseToDatasetItem(testCase).metadata).toEqual({ testCase });
    });
});

describe('selectDatasetItems()', () => {
    const testCase = (id: string): WorkflowTestCase => ({ id, category: 'basic', query: 'q' });

    it('returns the matching items in test case order', () => {
        const items = [{ id: 'b' }, { id: 'a' }, { id: 'c' }];
        const { selected, missingIds } = selectDatasetItems(items, [testCase('a'), testCase('c')]);
        expect(selected).toEqual([{ id: 'a' }, { id: 'c' }]);
        expect(missingIds).toEqual([]);
    });

    it('reports test cases with no dataset item instead of dropping them silently', () => {
        const { selected, missingIds } = selectDatasetItems([{ id: 'a' }], [testCase('a'), testCase('missing')]);
        expect(selected).toEqual([{ id: 'a' }]);
        expect(missingIds).toEqual(['missing']);
    });
});
