import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS, MAX_INLINE_BYTES } from '../../src/const.js';
import { extractDotPrefixes, getDatasetItems } from '../../src/tools/storage/get_dataset_items.js';
import { datasetItemsOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import { VERBATIM_LINKS_NUDGE } from '../../src/utils/console_link.js';
import { getUserInfoCached } from '../../src/utils/userid_cache.js';
import { type DatasetItemsServer, startDatasetItemsServer } from './helpers/dataset_items_server.js';
import {
    apiErrorResponse,
    datasetItemsResponse,
    expectSchemaConformingStructuredContent,
    expectSoftFailInvalidInput,
    mockDatasetItemsClient,
    mockUserInfo,
    stubToolCallContext,
    type TextToolResult,
    type ToolTelemetrySnapshot,
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

    it('skips a prefix that is also selected on its own', () => {
        expect(extractDotPrefixes(['metadata.url', 'metadata', 'crawl.statusCode'])).toEqual(['crawl']);
    });
});

const MOCK_ITEMS = [{ first_number: 3, second_number: 4, sum: 7 }];
const MANY_ITEMS = Array.from({ length: 20 }, (_, i) => ({ n: i }));

function stubApifyClient(
    page: { items: unknown[]; total: number } = { items: MOCK_ITEMS, total: 1 },
): InternalToolArgs['apifyClient'] {
    return mockDatasetItemsClient(async () => datasetItemsResponse(page.items, page.total));
}

describe('get-dataset-items', () => {
    it('has the expected tool name', () => {
        expect(getDatasetItems.name).toBe(HELPER_TOOLS.DATASET_GET_ITEMS);
    });

    it('returns dataset items in structuredContent on happy path', async () => {
        const result = await (getDatasetItems as HelperTool).call(
            stubToolCallContext({ datasetId: 'DsWkzbQMuFYuam3YF' }, stubApifyClient()),
        );
        const { structuredContent } = result as { structuredContent: Record<string, unknown> };

        expect(structuredContent.datasetId).toBe('DsWkzbQMuFYuam3YF');
        expect(structuredContent.itemCount).toBe(MOCK_ITEMS.length);
    });

    it('encodes the data payload (without summary/nextStep) into the JSON content text', async () => {
        const result = await (getDatasetItems as HelperTool).call(
            stubToolCallContext({ datasetId: 'DsWkzbQMuFYuam3YF' }, stubApifyClient()),
        );
        const { content, structuredContent } = result as TextToolResult;

        const { summary, nextStep, ...data } = structuredContent as Record<string, unknown>;
        expect(JSON.parse(content[0].text)).toEqual(data);
    });

    it('defaults `limit` to 20 when caller omits it', async () => {
        const result = await (getDatasetItems as HelperTool).call(
            stubToolCallContext({ datasetId: 'DsWkzbQMuFYuam3YF' }, stubApifyClient()),
        );
        const { structuredContent } = result as { structuredContent: Record<string, unknown> };

        expect(structuredContent).toHaveProperty('limit', 20);
    });

    it('echoes the caller-provided `limit` in structuredContent', async () => {
        const result = await (getDatasetItems as HelperTool).call(
            stubToolCallContext({ datasetId: 'DsWkzbQMuFYuam3YF', limit: 10 }, stubApifyClient()),
        );
        const { structuredContent } = result as { structuredContent: Record<string, unknown> };

        expect(structuredContent).toHaveProperty('limit', 10);
    });

    it('emits structuredContent that validates against the outputSchema for an empty dataset', async () => {
        const result = await (getDatasetItems as HelperTool).call(
            stubToolCallContext({ datasetId: 'DsWkzbQMuFYuam3YF' }, stubApifyClient({ items: [], total: 0 })),
        );
        expectSchemaConformingStructuredContent(result, datasetItemsOutputSchema);
    });

    it('returns isError with a not-found message when the API responds 404', async () => {
        const client = mockDatasetItemsClient(async () =>
            apiErrorResponse(404, 'record-not-found', 'Dataset was not found'),
        );
        const result = await (getDatasetItems as HelperTool).call(
            stubToolCallContext({ datasetId: 'missing' }, client),
        );
        const { content, structuredContent } = result as TextToolResult & { structuredContent?: unknown };

        expectSoftFailInvalidInput(result);
        expect(structuredContent).toBeUndefined();
        expect(content[0].text).toContain("Dataset 'missing' not found");
    });

    it('throws a non-404 API error response', async () => {
        const client = mockDatasetItemsClient(async () =>
            apiErrorResponse(500, 'internal-error', 'Internal server error'),
        );
        await expect(
            (getDatasetItems as HelperTool).call(stubToolCallContext({ datasetId: 'DsWkzbQMuFYuam3YF' }, client)),
        ).rejects.toMatchObject({ statusCode: 500, message: 'Internal server error' });
    });

    it('auto-derives flatten from dot-notation in fields', async () => {
        const requestSpy = vi.fn().mockResolvedValue(datasetItemsResponse([], 0));

        await (getDatasetItems as HelperTool).call(
            stubToolCallContext(
                {
                    datasetId: 'DsWkzbQMuFYuam3YF',
                    fields: 'metadata.url,crawl.statusCode,crawl',
                },
                mockDatasetItemsClient(requestSpy),
            ),
        );

        expect(requestSpy).toHaveBeenCalledWith(
            expect.objectContaining({ params: expect.objectContaining({ flatten: ['metadata'] }) }),
        );
    });

    it('rejects empty datasetId via ajv validation', () => {
        const tool = getDatasetItems as HelperTool;
        expect(tool.ajvValidate({ datasetId: '' })).toBe(false);
        expect(tool.ajvValidate({ datasetId: 'DsWkzbQMuFYuam3YF' })).toBe(true);
    });

    it('requests the items of the wrapper-stripped datasetId', async () => {
        const requestSpy = vi.fn().mockResolvedValue(datasetItemsResponse(MOCK_ITEMS, 1));

        const result = await (getDatasetItems as HelperTool).call(
            stubToolCallContext({ datasetId: '`user~my-dataset`' }, mockDatasetItemsClient(requestSpy)),
        );

        expect(requestSpy).toHaveBeenCalledWith(
            expect.objectContaining({ url: 'https://api.apify.com/v2/datasets/user~my-dataset/items' }),
        );
        const { structuredContent } = result as { structuredContent: Record<string, unknown> };
        expect(structuredContent.datasetId).toBe('user~my-dataset');
    });

    it('adds the dataset Console link to structuredContent and content for Console UI token sessions', async () => {
        vi.mocked(getUserInfoCached).mockResolvedValue(mockUserInfo());

        const result = await (getDatasetItems as HelperTool).call({
            ...stubToolCallContext({ datasetId: 'DsWkzbQMuFYuam3YF' }, stubApifyClient()),
            apifyToken: 'apify_ui_test',
        });
        const { structuredContent, content } = result as TextToolResult & {
            structuredContent: Record<string, unknown>;
        };

        expect(structuredContent.apifyConsoleUrl).toBe('https://console.apify.com/storage/datasets/DsWkzbQMuFYuam3YF');
        // content: [0] plain JSON, [1] summary/nextStep, [2] Apify Console link.
        expect(content).toHaveLength(3);
        expect(content[2].text).toBe(
            `Apify Console: https://console.apify.com/storage/datasets/DsWkzbQMuFYuam3YF\n${VERBATIM_LINKS_NUDGE}`,
        );
    });

    it('emits a last-page summary and a get-dataset nextStep when all items are returned', async () => {
        const result = await (getDatasetItems as HelperTool).call(
            stubToolCallContext({ datasetId: 'DsWkzbQMuFYuam3YF' }, stubApifyClient()),
        );
        const { content, structuredContent } = result as TextToolResult & {
            structuredContent: Record<string, unknown>;
        };

        expect(structuredContent.nextStep).toContain(HELPER_TOOLS.DATASET_GET);
        expect(structuredContent.nextStep).toContain('datasetId=DsWkzbQMuFYuam3YF');
        // summary + nextStep ship as a separate text block after the plain JSON.
        expect(content[1].text).toBe(`${structuredContent.summary}\n${structuredContent.nextStep}`);
    });

    it('emits a pagination nextStep when more items remain', async () => {
        const result = await (getDatasetItems as HelperTool).call(
            stubToolCallContext({ datasetId: 'DsWkzbQMuFYuam3YF' }, stubApifyClient({ items: MANY_ITEMS, total: 100 })),
        );
        const { structuredContent } = result as { structuredContent: Record<string, unknown> };

        expect(structuredContent.nextStep).toContain(HELPER_TOOLS.DATASET_GET_ITEMS);
    });

    it('content[0] mirrors the structuredContent data and does not echo the desc input param', async () => {
        const result = await (getDatasetItems as HelperTool).call(
            stubToolCallContext({ datasetId: 'DsWkzbQMuFYuam3YF' }, stubApifyClient()),
        );
        const { content, structuredContent } = result as TextToolResult & {
            structuredContent: Record<string, unknown>;
        };

        const { summary, nextStep, ...data } = structuredContent;
        expect(JSON.parse(content[0].text)).toEqual(data);
        expect(structuredContent).not.toHaveProperty('desc');
    });
});

describe('get-dataset-items response size', () => {
    it('reads the items in one streamed request', async () => {
        const requestSpy = vi.fn().mockResolvedValue(datasetItemsResponse(MOCK_ITEMS, 1));

        await (getDatasetItems as HelperTool).call(
            stubToolCallContext({ datasetId: 'DsWkzbQMuFYuam3YF', limit: 5 }, mockDatasetItemsClient(requestSpy)),
        );

        expect(requestSpy).toHaveBeenCalledOnce();
        expect(requestSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                method: 'GET',
                responseType: 'stream',
                params: expect.objectContaining({ limit: 5 }),
            }),
        );
    });
});

describe('get-dataset-items over the response size limit', () => {
    let server: DatasetItemsServer;
    beforeAll(async () => {
        server = await startDatasetItemsServer();
        // Crawler-like items: 20 of them pass the size limit.
        const pages = Array.from({ length: 30 }, (_, n) => ({
            url: `https://example.com/${n}`,
            text: 'x'.repeat(20_000),
        }));
        server.serve('~crawl', [{ items: pages }]);
        // The first item ends just inside the size limit; the second one passes it.
        server.serve('~nearly', [{ items: [{ t: 'a'.repeat(MAX_INLINE_BYTES - 100) }, { t: 'b'.repeat(40_000) }] }]);
        const firstTooLarge = [{ items: [{ text: 'x'.repeat(MAX_INLINE_BYTES) }, { n: 2 }] }];
        for (const id of ['DsWkzbQMuFYuam3YF', 'user~big', '~big']) server.serve(id, firstTooLarge);
    });
    afterAll(async () => server.close());

    async function call(args: Record<string, unknown>) {
        const result = await (getDatasetItems as HelperTool).call(stubToolCallContext(args, server.client));
        return result as TextToolResult & {
            structuredContent?: Record<string, unknown>;
            toolTelemetry?: ToolTelemetrySnapshot;
        };
    }

    it('returns the whole items that fit, with the offset to continue from', async () => {
        const result = await call({ datasetId: 'crawl' });
        const { content, structuredContent } = result;
        const { summary, nextStep, ...data } = structuredContent!;

        expectSchemaConformingStructuredContent(result, datasetItemsOutputSchema);
        expect(data.itemCount).toBeGreaterThan(0);
        expect(data.itemCount).toBeLessThan(20);
        expect(data).toMatchObject({ offset: 0, limit: 20, totalItemCount: 30, nextOffset: data.itemCount });
        expect(summary).toContain(`${MAX_INLINE_BYTES}`);
        expect(nextStep).toContain(`offset=${data.itemCount}`);
        expect(JSON.parse(content[0].text)).toEqual(data);
        expect(content[1].text).toBe(`${summary}\n${nextStep}`);
    });

    it('returns a first item that ends inside the limit when the next one passes it', async () => {
        const { structuredContent } = await call({ datasetId: 'nearly' });

        expect(structuredContent).toMatchObject({ itemCount: 1, nextOffset: 1, totalItemCount: 2 });
    });

    it.each([
        { name: 'counts from the given offset, also in reverse order', args: { offset: 5, desc: true }, clean: false },
        { name: 'notes that a page can repeat items under clean=true', args: { clean: true }, clean: true },
    ])('$name', async ({ args, clean }) => {
        const { structuredContent } = await call({ datasetId: 'crawl', ...args });
        const { itemCount, nextOffset, nextStep } = structuredContent!;

        expect(nextOffset).toBe((args.offset ?? 0) + (itemCount as number));
        expect(nextStep).toContain(`offset=${nextOffset}`);
        expect((nextStep as string).includes('clean=true')).toBe(clean);
    });

    it('names fields and omit only when the call used neither', async () => {
        const plain = await call({ datasetId: 'crawl' });
        const projected = await call({ datasetId: 'crawl', omit: 'n' });

        expect(plain.structuredContent!.nextStep).toContain('fields or omit');
        expect(projected.structuredContent!.nextStep).not.toContain('fields or omit');
    });

    it.each([
        {
            datasetId: 'DsWkzbQMuFYuam3YF',
            url: 'https://api.apify.com/v2/datasets/DsWkzbQMuFYuam3YF/items?offset=0&limit=1',
        },
        { datasetId: 'user/big', url: 'https://api.apify.com/v2/datasets/user~big/items?offset=0&limit=1' },
        { datasetId: '~big', url: 'https://api.apify.com/v2/datasets/~big/items?offset=0&limit=1' },
        { datasetId: 'big', desc: true, url: 'https://api.apify.com/v2/datasets/~big/items?offset=0&limit=1&desc=1' },
    ])('returns an error with a download URL when the first item of $datasetId alone is too large', async (args) => {
        const { url, ...callArgs } = args;
        const result = await call(callArgs);
        const { text } = result.content[0];

        expectSoftFailInvalidInput(result);
        expect(result.structuredContent).toBeUndefined();
        expect(text).toContain(`${url} `);
        expect(text).toContain('fields or omit');
    });

    it('does not name fields or omit for a single item when the call used them', async () => {
        const result = await call({ datasetId: 'big', fields: 'text' });

        expectSoftFailInvalidInput(result);
        expect(result.content[0].text).not.toContain('fields or omit');
    });
});

describe('get-dataset-items with a bare dataset name', () => {
    it("reads the name as one of the caller's own datasets", async () => {
        const requestSpy = vi.fn().mockResolvedValue(datasetItemsResponse(MOCK_ITEMS, 1));

        await (getDatasetItems as HelperTool).call(
            stubToolCallContext({ datasetId: 'eval-ai-items' }, mockDatasetItemsClient(requestSpy)),
        );

        expect(requestSpy).toHaveBeenCalledWith(
            expect.objectContaining({ url: 'https://api.apify.com/v2/datasets/~eval-ai-items/items' }),
        );
    });

    it('links Console to the dataset ID, which the list response does not carry', async () => {
        vi.mocked(getUserInfoCached).mockResolvedValue(mockUserInfo());
        const client = mockDatasetItemsClient(async () => datasetItemsResponse(MOCK_ITEMS, 1), {
            get: async () => ({ id: 'WkzbQMuFYuamGv3YF', name: 'eval-ai-items' }),
        });

        const result = await (getDatasetItems as HelperTool).call({
            ...stubToolCallContext({ datasetId: 'eval-ai-items' }, client),
            apifyToken: 'apify_ui_test',
        });
        const { structuredContent } = result as { structuredContent: Record<string, unknown> };

        expect(structuredContent.apifyConsoleUrl).toBe('https://console.apify.com/storage/datasets/WkzbQMuFYuamGv3YF');
    });
});
