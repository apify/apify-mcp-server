import { describe, expect, it, vi } from 'vitest';

import { HelperTools } from '../../src/const.js';
import { extractDotPrefixes, getDatasetItems } from '../../src/tools/common/get_dataset_items.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import { expectSoftFailInvalidInput, stubToolCallContext, type TextToolResult } from './helpers/tool_context.js';

describe('extractDotPrefixes', () => {
    it('returns empty list when no fields contain a dot', () => {
        expect(extractDotPrefixes(['title', 'url'])).toEqual([]);
    });

    it('extracts unique top-level prefixes from dot-notation fields', () => {
        expect(extractDotPrefixes(['metadata.url', 'crawl.statusCode', 'title'])).toEqual(['metadata', 'crawl']);
    });

    it('deduplicates repeated prefixes', () => {
        expect(extractDotPrefixes(['metadata.url', 'metadata.title'])).toEqual(['metadata']);
    });

    it('handles mixed deep and shallow paths', () => {
        expect(extractDotPrefixes(['a.b.c', 'a.x', 'd'])).toEqual(['a']);
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
const MANY_ITEMS = Array.from({ length: 20 }, (_, i) => ({ n: i }));

function stubApifyClient(
    listItems: (...args: unknown[]) => unknown = async () => ({ items: MOCK_ITEMS, total: 1 }),
): InternalToolArgs['apifyClient'] {
    return {
        dataset: (_id: string) => ({ listItems }),
    } as unknown as InternalToolArgs['apifyClient'];
}

function stubApifyClientThrowing(err: unknown): InternalToolArgs['apifyClient'] {
    return stubApifyClient(async () => {
        throw err;
    });
}

describe('get-dataset-items', () => {
    it('has the expected tool name', () => {
        expect(getDatasetItems.name).toBe(HelperTools.DATASET_GET_ITEMS);
    });

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

    it('returns isError with a not-found message when listItems throws 404', async () => {
        const notFound = Object.assign(new Error('Dataset was not found'), { statusCode: 404 });
        const result = await (getDatasetItems as HelperTool).call(
            stubToolCallContext({ datasetId: 'missing' }, stubApifyClientThrowing(notFound)),
        );
        const { content } = result as TextToolResult;

        expectSoftFailInvalidInput(result);
        expect(content[0].text).toContain("Dataset 'missing' not found");
    });

    it('rethrows non-404 errors from listItems', async () => {
        const serverError = Object.assign(new Error('Internal server error'), { statusCode: 500 });
        await expect(
            (getDatasetItems as HelperTool).call(
                stubToolCallContext({ datasetId: 'ds-1' }, stubApifyClientThrowing(serverError)),
            ),
        ).rejects.toBe(serverError);
    });

    it('auto-derives flatten from dot-notation in fields', async () => {
        const listItemsSpy = vi.fn().mockResolvedValue({ items: [], total: 0 });

        await (getDatasetItems as HelperTool).call(
            stubToolCallContext(
                {
                    datasetId: 'ds-1',
                    fields: 'metadata.url,crawl.statusCode',
                },
                stubApifyClient(listItemsSpy),
            ),
        );

        expect(listItemsSpy).toHaveBeenCalledWith(expect.objectContaining({ flatten: ['metadata', 'crawl'] }));
    });

    it('rejects empty datasetId via ajv validation', () => {
        const tool = getDatasetItems as HelperTool;
        expect(tool.ajvValidate({ datasetId: '' })).toBe(false);
        expect(tool.ajvValidate({ datasetId: 'ds-1' })).toBe(true);
    });

    it('passes the wrapper-stripped datasetId to client.dataset()', async () => {
        const datasetSpy = vi.fn().mockReturnValue({ listItems: async () => ({ items: MOCK_ITEMS, total: 1 }) });
        const client = { dataset: datasetSpy } as unknown as InternalToolArgs['apifyClient'];

        const result = await (getDatasetItems as HelperTool).call(
            stubToolCallContext({ datasetId: '`user~my-dataset`' }, client),
        );

        expect(datasetSpy).toHaveBeenCalledWith('user~my-dataset');
        const { structuredContent } = result as { structuredContent: Record<string, unknown> };
        expect(structuredContent.datasetId).toBe('user~my-dataset');
    });

    it('emits a last-page summary and a schema nextStep when all items are returned', async () => {
        const result = await (getDatasetItems as HelperTool).call(
            stubToolCallContext({ datasetId: 'ds-1' }, stubApifyClient()),
        );
        const { content, structuredContent } = result as TextToolResult & {
            structuredContent: Record<string, unknown>;
        };

        expect(structuredContent.summary).toBe('Fetched all 1 items.');
        expect(structuredContent.nextStep).toContain(HelperTools.DATASET_SCHEMA_GET);
        expect(structuredContent.nextStep).toContain('datasetId=ds-1');
        // content[1] mirrors summary + nextStep for text-only clients.
        expect(content[1].text).toBe(`${structuredContent.summary}\n${structuredContent.nextStep}`);
    });

    it('emits a pagination nextStep when more items remain', async () => {
        const result = await (getDatasetItems as HelperTool).call(
            stubToolCallContext(
                { datasetId: 'ds-1' },
                stubApifyClient(async () => ({ items: MANY_ITEMS, total: 100 })),
            ),
        );
        const { structuredContent } = result as { structuredContent: Record<string, unknown> };

        expect(structuredContent.summary).toBe('Fetched 20 of 100 items (offset=0).');
        expect(structuredContent.nextStep).toBe(
            `Call ${HelperTools.DATASET_GET_ITEMS} again with offset=20 to fetch the next page.`,
        );
    });

    it('content[0] is the plain-JSON dump of structuredContent (no raw desc echo)', async () => {
        const result = await (getDatasetItems as HelperTool).call(
            stubToolCallContext({ datasetId: 'ds-1' }, stubApifyClient()),
        );
        const { content, structuredContent } = result as TextToolResult & {
            structuredContent: Record<string, unknown>;
        };

        expect(JSON.parse(content[0].text)).toEqual(structuredContent);
        expect(structuredContent).not.toHaveProperty('desc');
    });
});
