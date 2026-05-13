import { describe, expect, it } from 'vitest';

import { deriveFlattenFromFields, getDatasetItems } from '../../src/tools/common/get_dataset_items.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';

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

    it('skips fields with leading dot (no top-level prefix)', () => {
        expect(deriveFlattenFromFields(['.a', '.b.c'])).toEqual([]);
    });

    it('extracts the prefix from fields with a trailing dot', () => {
        expect(deriveFlattenFromFields(['a.', 'b.c'])).toEqual(['a', 'b']);
    });
});

const MOCK_ITEMS = [{ first_number: 3, second_number: 4, sum: 7 }];

function stubApifyClient(returnTotal = 1): InternalToolArgs['apifyClient'] {
    return {
        dataset: (_id: string) => ({
            listItems: async (_opts: unknown) => ({
                items: MOCK_ITEMS,
                total: returnTotal,
            }),
        }),
    } as unknown as InternalToolArgs['apifyClient'];
}

function stubArgs(args: Record<string, unknown>): InternalToolArgs {
    return {
        args,
        apifyToken: 'test-token',
        apifyClient: stubApifyClient(),
        extra: {} as InternalToolArgs['extra'],
        mcpServer: {} as InternalToolArgs['mcpServer'],
        apifyMcpServer: { options: { paymentProvider: undefined } } as InternalToolArgs['apifyMcpServer'],
    } as InternalToolArgs;
}

describe('get-dataset-items structuredContent', () => {
    it('echoes the default `limit` of 20 when caller did not provide one', async () => {
        const result = await (getDatasetItems as HelperTool).call(
            stubArgs({ datasetId: 'ds-1' }),
        );
        const { structuredContent } = result as { structuredContent: Record<string, unknown> };

        expect(structuredContent).toHaveProperty('limit', 20);
        expect(structuredContent.datasetId).toBe('ds-1');
        expect(structuredContent.itemCount).toBe(MOCK_ITEMS.length);
    });

    it('echoes the caller-provided `limit` in structuredContent', async () => {
        const result = await (getDatasetItems as HelperTool).call(
            stubArgs({ datasetId: 'ds-1', limit: 10 }),
        );
        const { structuredContent } = result as { structuredContent: Record<string, unknown> };

        expect(structuredContent).toHaveProperty('limit', 10);
    });
});
