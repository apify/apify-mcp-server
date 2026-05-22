import { describe, expect, it, vi } from 'vitest';

import { extractDotPrefixes, getDatasetItems } from '../../src/tools/common/get_dataset_items.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import { stubToolCallContext, type TextToolResult } from '../helpers.js';

describe('extractDotPrefixes', () => {
    it('returns empty list when no fields contain a dot', () => {
        expect(extractDotPrefixes(['title', 'url'])).toEqual([]);
    });

    it('extracts unique top-level prefixes from dot-notation fields', () => {
        expect(extractDotPrefixes(['metadata.url', 'crawl.statusCode', 'title']))
            .toEqual(['metadata', 'crawl']);
    });

    it('deduplicates repeated prefixes', () => {
        expect(extractDotPrefixes(['metadata.url', 'metadata.title']))
            .toEqual(['metadata']);
    });

    it('handles mixed deep and shallow paths', () => {
        expect(extractDotPrefixes(['a.b.c', 'a.x', 'd']))
            .toEqual(['a']);
    });

    it('returns empty list for empty input', () => {
        expect(extractDotPrefixes([])).toEqual([]);
    });

    it('skips fields with leading dot (no top-level prefix)', () => {
        expect(extractDotPrefixes(['.a', '.b.c'])).toEqual([]);
    });

    it('extracts the prefix from fields with a trailing dot', () => {
        expect(extractDotPrefixes(['a.', 'b.c'])).toEqual(['a', 'b']);
    });
});

const MOCK_ITEMS = [{ first_number: 3, second_number: 4, sum: 7 }];

function stubApifyClient(
    listItems: (...args: unknown[]) => unknown = async () => ({ items: MOCK_ITEMS, total: 1 }),
): InternalToolArgs['apifyClient'] {
    return {
        dataset: (_id: string) => ({ listItems }),
    } as unknown as InternalToolArgs['apifyClient'];
}

describe('get-dataset-items', () => {
    it('returns dataset items in structuredContent on happy path', async () => {
        const result = await (getDatasetItems as HelperTool).call(
            stubToolCallContext({ datasetId: 'ds-1' }, stubApifyClient()),
        );
        const { structuredContent } = result as { structuredContent: Record<string, unknown> };

        expect(structuredContent.datasetId).toBe('ds-1');
        expect(structuredContent.itemCount).toBe(MOCK_ITEMS.length);
    });

    it('defaults `limit` to 20 when caller omits it', async () => {
        const result = await (getDatasetItems as HelperTool).call(
            stubToolCallContext({ datasetId: 'ds-1' }, stubApifyClient()),
        );
        const { structuredContent } = result as { structuredContent: Record<string, unknown> };

        expect(structuredContent).toHaveProperty('limit', 20);
    });

    it('echoes the caller-provided `limit` in structuredContent', async () => {
        const result = await (getDatasetItems as HelperTool).call(
            stubToolCallContext({ datasetId: 'ds-1', limit: 10 }, stubApifyClient()),
        );
        const { structuredContent } = result as { structuredContent: Record<string, unknown> };

        expect(structuredContent).toHaveProperty('limit', 10);
    });

    it('returns isError with a not-found message when listItems returns no response', async () => {
        const result = await (getDatasetItems as HelperTool).call(
            stubToolCallContext({ datasetId: 'missing' }, stubApifyClient(async () => null)),
        );
        const { content, isError } = result as TextToolResult;

        expect(isError).toBe(true);
        expect(content[0].text).toContain("Dataset 'missing' not found");
    });

    it('auto-derives flatten from dot-notation in fields', async () => {
        const listItemsSpy = vi.fn().mockResolvedValue({ items: [], total: 0 });

        await (getDatasetItems as HelperTool).call(stubToolCallContext({
            datasetId: 'ds-1',
            fields: 'metadata.url,crawl.statusCode',
        }, stubApifyClient(listItemsSpy)));

        expect(listItemsSpy).toHaveBeenCalledWith(
            expect.objectContaining({ flatten: ['metadata', 'crawl'] }),
        );
    });

    it('rejects empty datasetId via ajv validation', () => {
        const tool = getDatasetItems as HelperTool;
        expect(tool.ajvValidate({ datasetId: '' })).toBe(false);
        expect(tool.ajvValidate({ datasetId: 'ds-1' })).toBe(true);
    });
});
