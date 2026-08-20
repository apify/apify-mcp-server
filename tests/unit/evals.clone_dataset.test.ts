import { describe, expect, it } from 'vitest';

import { buildTargetMetadata } from '../../evals/workflows/clone_dataset.js';
import type { DatasetItem, WorkflowCase } from '../../evals/workflows/langfuse_dataset.js';

function makeCase(overrides: Partial<WorkflowCase> = {}): WorkflowCase {
    return {
        id: 'storage-kv-keys-seeded',
        category: 'storage',
        query: 'run it then list the keys',
        reference: 'must call call-actor then get-key-value-store-keys',
        tools: ['actors', 'get-key-value-store-keys'],
        item: { id: 'storage-kv-keys-seeded' } as DatasetItem,
        ...overrides,
    };
}

describe('buildTargetMetadata()', () => {
    it('keeps the harness knobs and adds the expected tools for a mapped case', () => {
        const metadata = buildTargetMetadata(makeCase(), { 'storage-kv-keys-seeded': ['call-actor'] });

        expect(metadata).toEqual({
            category: 'storage',
            tools: ['actors', 'get-key-value-store-keys'],
            expectedTools: ['call-actor'],
        });
    });

    it('omits expectedTools for a case with more than one valid path', () => {
        expect(buildTargetMetadata(makeCase(), {})).not.toHaveProperty('expectedTools');
    });

    it('drops the raw Langfuse item, which the strict validator would reject on read back', () => {
        expect(buildTargetMetadata(makeCase(), {})).not.toHaveProperty('item');
    });
});
