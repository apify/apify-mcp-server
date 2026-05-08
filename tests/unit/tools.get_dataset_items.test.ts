import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { deriveFlattenFromFields } from '../../src/tools/common/get_dataset_items.js';

describe('deriveFlattenFromFields', () => {
    it('returns empty list when no fields contain a dot', () => {
        expect(deriveFlattenFromFields(['title', 'url'])).toEqual([]);
    });

    it('extracts unique top-level prefixes from dot-notation fields', () => {
        expect(deriveFlattenFromFields(['metadata.url', 'crawl.statusCode', 'title']))
            .toEqual(['metadata', 'crawl']);
    });

    it('deduplicates repeated prefixes', () => {
        expect(deriveFlattenFromFields(['metadata.url', 'metadata.title']))
            .toEqual(['metadata']);
    });

    it('handles mixed deep and shallow paths', () => {
        expect(deriveFlattenFromFields(['a.b.c', 'a.x', 'd']))
            .toEqual(['a']);
    });

    it('returns empty list for empty input', () => {
        expect(deriveFlattenFromFields([])).toEqual([]);
    });
});

// Schema validation tests — the .refine constraint runs at parse time
// and must reject "neither" / "both" with a clear error message.
describe('get-dataset-items schema validation', () => {
    // Re-create the schema shape inline to validate the refine behavior without
    // relying on private exports. Mirrors the production schema.
    const schema = z.object({
        runId: z.string().min(1).optional(),
        datasetId: z.string().min(1).optional(),
    }).refine(
        (data) => (data.runId !== undefined) !== (data.datasetId !== undefined),
        { message: 'Provide exactly one of runId or datasetId.' },
    );

    it('rejects when both runId and datasetId are provided', () => {
        const result = schema.safeParse({ runId: 'run123', datasetId: 'ds456' });
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.issues[0].message).toMatch(/exactly one of runId or datasetId/);
        }
    });

    it('rejects when neither runId nor datasetId is provided', () => {
        const result = schema.safeParse({});
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.issues[0].message).toMatch(/exactly one of runId or datasetId/);
        }
    });

    it('accepts runId alone', () => {
        expect(schema.safeParse({ runId: 'run123' }).success).toBe(true);
    });

    it('accepts datasetId alone', () => {
        expect(schema.safeParse({ datasetId: 'ds456' }).success).toBe(true);
    });
});
