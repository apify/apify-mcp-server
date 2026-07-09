import { describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { extractDotPrefixes, getDatasetItems } from '../../src/tools/storage/get_dataset_items.js';
import { datasetItemsOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import { VERBATIM_LINKS_NUDGE } from '../../src/utils/console_link.js';
import { getUserInfoCached } from '../../src/utils/userid_cache.js';
import {
    expectSoftFailInvalidInput,
    expectSchemaConformingStructuredContent,
    mockUserInfo,
    stubToolCallContext,
    type TextToolResult,
} from './helpers/tool_context.js';

// Only Console UI token sessions reach the users/me lookup.
vi.mock('../../src/utils/userid_cache.js', () => ({
    getUserInfoCached: vi.fn(),
}));

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
        expect(getDatasetItems.name).toBe(HELPER_TOOLS.DATASET_GET_ITEMS);
    });

    it('returns dataset items in structuredContent on happy path', async () => {
        const result = await (getDatasetItems as HelperTool).call(
            stubToolCallContext({ datasetId: 'ds-1' }, stubApifyClient()),
        );
        const { structuredContent } = result as { structuredContent: Record<string, unknown> };

        expect(structuredContent.datasetId).toBe('ds-1');
        expect(structuredContent.itemCount).toBe(MOCK_ITEMS.length);
    });

    it('encodes the data payload (without summary/nextStep) into the JSON content text', async () => {
        const result = await (getDatasetItems as HelperTool).call(
            stubToolCallContext({ datasetId: 'ds-1' }, stubApifyClient()),
        );
        const { content, structuredContent } = result as TextToolResult;

        const { summary, nextStep, ...data } = structuredContent as Record<string, unknown>;
        expect(JSON.parse(content[0].text)).toEqual(data);
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

    it('emits structuredContent that validates against the outputSchema for an empty dataset', async () => {
        const result = await (getDatasetItems as HelperTool).call(
            stubToolCallContext(
                { datasetId: 'ds-1' },
                stubApifyClient(async () => ({ items: [], total: 0 })),
            ),
        );
        expectSchemaConformingStructuredContent(result, datasetItemsOutputSchema);
    });

    it('returns isError with a not-found message when listItems throws 404', async () => {
        const notFound = Object.assign(new Error('Dataset was not found'), { statusCode: 404 });
        const result = await (getDatasetItems as HelperTool).call(
            stubToolCallContext({ datasetId: 'missing' }, stubApifyClientThrowing(notFound)),
        );
        const { content, structuredContent } = result as TextToolResult & { structuredContent?: unknown };

        expectSoftFailInvalidInput(result);
        expect(structuredContent).toBeUndefined();
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

    it('adds the dataset Console link to structuredContent and content for Console UI token sessions', async () => {
        vi.mocked(getUserInfoCached).mockResolvedValue(mockUserInfo());

        const result = await (getDatasetItems as HelperTool).call({
            ...stubToolCallContext({ datasetId: 'ds-1' }, stubApifyClient()),
            apifyToken: 'apify_ui_test',
        });
        const { structuredContent, content } = result as TextToolResult & {
            structuredContent: Record<string, unknown>;
        };

        expect(structuredContent.apifyConsoleUrl).toBe('https://console.apify.com/storage/datasets/ds-1');
        // content: [0] plain JSON, [1] summary/nextStep, [2] Apify Console link.
        expect(content).toHaveLength(3);
        expect(content[2].text).toBe(
            `Apify Console: https://console.apify.com/storage/datasets/ds-1\n${VERBATIM_LINKS_NUDGE}`,
        );
    });

    it('emits a last-page summary and a get-dataset nextStep when all items are returned', async () => {
        const result = await (getDatasetItems as HelperTool).call(
            stubToolCallContext({ datasetId: 'ds-1' }, stubApifyClient()),
        );
        const { content, structuredContent } = result as TextToolResult & {
            structuredContent: Record<string, unknown>;
        };

        expect(structuredContent.summary).toBe('Fetched all 1 items.');
        expect(structuredContent.nextStep).toContain(HELPER_TOOLS.DATASET_GET);
        expect(structuredContent.nextStep).toContain('datasetId=ds-1');
        // summary + nextStep ship as a separate text block after the plain JSON.
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
            `Call ${HELPER_TOOLS.DATASET_GET_ITEMS} again with offset=20 to fetch the next page.`,
        );
    });

    it('content[0] mirrors the structuredContent data and does not echo the desc input param', async () => {
        const result = await (getDatasetItems as HelperTool).call(
            stubToolCallContext({ datasetId: 'ds-1' }, stubApifyClient()),
        );
        const { content, structuredContent } = result as TextToolResult & {
            structuredContent: Record<string, unknown>;
        };

        const { summary, nextStep, ...data } = structuredContent;
        expect(JSON.parse(content[0].text)).toEqual(data);
        expect(structuredContent).not.toHaveProperty('desc');
    });
});
