import { describe, expect, it } from 'vitest';

import { testCaseToDatasetItem, WORKFLOW_DATASET_NAME } from '../../evals/workflows/langfuse_dataset.js';
import type { WorkflowTestCase } from '../../evals/workflows/test_cases_loader.js';

describe('testCaseToDatasetItem()', () => {
    it('uses the test case id as the item id for idempotent upsert', () => {
        const testCase: WorkflowTestCase = { id: 'search-001', category: 'search', query: 'q', reference: 'r' };
        const item = testCaseToDatasetItem(testCase);
        expect(item.datasetName).toBe(WORKFLOW_DATASET_NAME);
        expect(item.id).toBe('search-001');
        expect(item.input).toEqual({ query: 'q' });
        expect(item.expectedOutput).toBe('r');
        expect(item.metadata).toEqual({ category: 'search' });
    });

    it('uses null expectedOutput when there is no reference', () => {
        const testCase: WorkflowTestCase = { id: 'a', category: 'basic', query: 'q' };
        expect(testCaseToDatasetItem(testCase).expectedOutput).toBeNull();
    });

    it('carries optional fields into metadata only when present', () => {
        const testCase: WorkflowTestCase = {
            id: 'a',
            category: 'basic',
            query: 'q',
            maxTurns: 5,
            tools: ['actors'],
            failTools: ['call-actor'],
        };
        expect(testCaseToDatasetItem(testCase).metadata).toEqual({
            category: 'basic',
            maxTurns: 5,
            tools: ['actors'],
            failTools: ['call-actor'],
        });
    });
});
