import { describe, expect, it } from 'vitest';

import type { CallActorGetDatasetResult } from '../../src/tools/core/actor_execution.js';
import { buildActorResponseContent } from '../../src/tools/core/actor_response.js';

const baseResult: CallActorGetDatasetResult = {
    runId: 'run-123',
    datasetId: 'dataset-123',
    totalItemCount: 2,
    previewItemCount: 2,
    schema: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' } } } },
    previewItems: [{ title: 'first' }, { title: 'second' }],
};

describe('buildActorResponseContent', () => {
    it('serializes structuredContent into a TextContent block (MCP spec conformance)', () => {
        const { content, structuredContent } = buildActorResponseContent('apify/rag-web-browser', baseResult);

        const serialized = content.find((block) => block.text === JSON.stringify(structuredContent));
        expect(serialized).toBeDefined();
    });

    it('keeps a human-readable text block with metadata and instructions', () => {
        const { content } = buildActorResponseContent('apify/rag-web-browser', baseResult);

        const humanText = content.map((block) => block.text).join('\n');
        expect(humanText).toContain('apify/rag-web-browser');
        expect(humanText).toContain('run-123');
        expect(humanText).toContain('dataset-123');
        expect(humanText).toContain('get-actor-output');
    });

    it('still serializes structuredContent when no preview items are available', () => {
        const emptyResult: CallActorGetDatasetResult = {
            ...baseResult,
            totalItemCount: 0,
            previewItemCount: 0,
            previewItems: [],
        };

        const { content, structuredContent } = buildActorResponseContent('apify/rag-web-browser', emptyResult);

        expect(structuredContent.items).toEqual([]);
        const serialized = content.find((block) => block.text === JSON.stringify(structuredContent));
        expect(serialized).toBeDefined();
        expect(structuredContent.instructions).toContain('No items available');
    });
});
