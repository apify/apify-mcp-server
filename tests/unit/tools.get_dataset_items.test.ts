import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { describe, expect, it, vi } from 'vitest';

import { ApifyClient } from '../../src/apify_client.js';
import { HELPER_TOOLS, MAX_INLINE_BYTES } from '../../src/const.js';
import { extractDotPrefixes, getDatasetItems } from '../../src/tools/storage/get_dataset_items.js';
import { datasetItemsOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import { VERBATIM_LINKS_NUDGE } from '../../src/utils/console_link.js';
import { getUserInfoCached } from '../../src/utils/userid_cache.js';
import {
    type DatasetItemsReply,
    expectSchemaConformingStructuredContent,
    expectSoftFailInvalidInput,
    mockDatasetItemsClient,
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

    it('skips a prefix that is also selected on its own', () => {
        expect(extractDotPrefixes(['metadata.url', 'metadata', 'crawl.statusCode'])).toEqual(['crawl']);
    });
});

const MOCK_ITEMS = [{ first_number: 3, second_number: 4, sum: 7 }];
const MANY_ITEMS = Array.from({ length: 20 }, (_, i) => ({ n: i }));

function stubApifyClient(
    reply: (params: Record<string, unknown>) => DatasetItemsReply = () => ({ items: MOCK_ITEMS, total: 1 }),
): InternalToolArgs['apifyClient'] {
    return mockDatasetItemsClient(reply);
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
            stubToolCallContext(
                { datasetId: 'DsWkzbQMuFYuam3YF' },
                stubApifyClient(() => ({ items: [], total: 0 })),
            ),
        );
        expectSchemaConformingStructuredContent(result, datasetItemsOutputSchema);
    });

    it('returns isError with a not-found message when the API returns 404', async () => {
        const result = await (getDatasetItems as HelperTool).call(
            stubToolCallContext(
                { datasetId: 'missing' },
                stubApifyClient(() => ({ status: 404 })),
            ),
        );
        const { content, structuredContent } = result as TextToolResult & { structuredContent?: unknown };

        expectSoftFailInvalidInput(result);
        expect(structuredContent).toBeUndefined();
        expect(content[0].text).toContain("Dataset 'missing' not found");
    });

    it('throws an API error other than 404', async () => {
        await expect(
            (getDatasetItems as HelperTool).call(
                stubToolCallContext(
                    { datasetId: 'DsWkzbQMuFYuam3YF' },
                    stubApifyClient(() => ({ status: 403 })),
                ),
            ),
        ).rejects.toMatchObject({ statusCode: 403 });
    });

    // A cut-off response can end without a network error; apify-client's `listItems()` retried it too.
    it('reads the page once more when the body does not parse', async () => {
        const replies: DatasetItemsReply[] = ['unparsable', { items: MOCK_ITEMS, total: 1 }];
        const result = await (getDatasetItems as HelperTool).call(
            stubToolCallContext(
                { datasetId: 'DsWkzbQMuFYuam3YF' },
                stubApifyClient(() => replies.shift()!),
            ),
        );
        const { structuredContent } = result as { structuredContent: Record<string, unknown> };

        expect(structuredContent.items).toEqual(MOCK_ITEMS);
    });

    it('names only fields and omit when one item is over the size limit', async () => {
        const result = await (getDatasetItems as HelperTool).call(
            stubToolCallContext(
                { datasetId: 'DsWkzbQMuFYuam3YF', limit: 1 },
                stubApifyClient(() => 'overLimit'),
            ),
        );
        const { content } = result as TextToolResult;

        expectSoftFailInvalidInput(result);
        expect(content[0].text).toContain('`fields` or `omit`');
        expect(content[0].text).not.toContain('Lower');
    });

    it('auto-derives flatten from dot-notation in fields', async () => {
        const requestSpy = vi.fn((_params: Record<string, unknown>) => ({ items: [], total: 0 }));

        await (getDatasetItems as HelperTool).call(
            stubToolCallContext(
                {
                    datasetId: 'DsWkzbQMuFYuam3YF',
                    fields: 'metadata.url,crawl.statusCode,crawl',
                },
                stubApifyClient(requestSpy),
            ),
        );

        expect(requestSpy).toHaveBeenCalledWith(expect.objectContaining({ flatten: ['metadata'] }));
    });

    it('rejects empty datasetId via ajv validation', () => {
        const tool = getDatasetItems as HelperTool;
        expect(tool.ajvValidate({ datasetId: '' })).toBe(false);
        expect(tool.ajvValidate({ datasetId: 'DsWkzbQMuFYuam3YF' })).toBe(true);
    });

    it('passes the wrapper-stripped datasetId to client.dataset()', async () => {
        const datasetSpy = vi.fn((id: string) => ({ url: `https://api.apify.com/v2/datasets/${id}` }));
        const client = mockDatasetItemsClient(() => ({ items: MOCK_ITEMS, total: 1 }), { dataset: datasetSpy });

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
            stubToolCallContext(
                { datasetId: 'DsWkzbQMuFYuam3YF' },
                stubApifyClient(() => ({ items: MANY_ITEMS, total: 100 })),
            ),
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

describe('get-dataset-items with a bare dataset name', () => {
    it("reads the name as one of the caller's own datasets", async () => {
        const datasetSpy = vi.fn((id: string) => ({ url: `https://api.apify.com/v2/datasets/${id}` }));

        await (getDatasetItems as HelperTool).call(
            stubToolCallContext(
                { datasetId: 'eval-ai-items' },
                mockDatasetItemsClient(() => ({ items: MOCK_ITEMS, total: 1 }), { dataset: datasetSpy }),
            ),
        );

        expect(datasetSpy).toHaveBeenCalledWith('~eval-ai-items');
    });

    it('links Console to the dataset ID, which the list response does not carry', async () => {
        vi.mocked(getUserInfoCached).mockResolvedValue(mockUserInfo());
        const client = mockDatasetItemsClient(() => ({ items: MOCK_ITEMS, total: 1 }), {
            dataset: (id: string) => ({
                url: `https://api.apify.com/v2/datasets/${id}`,
                get: async () => ({ id: 'WkzbQMuFYuamGv3YF', name: 'eval-ai-items' }),
            }),
        });

        const result = await (getDatasetItems as HelperTool).call({
            ...stubToolCallContext({ datasetId: 'eval-ai-items' }, client),
            apifyToken: 'apify_ui_test',
        });
        const { structuredContent } = result as { structuredContent: Record<string, unknown> };

        expect(structuredContent.apifyConsoleUrl).toBe('https://console.apify.com/storage/datasets/WkzbQMuFYuamGv3YF');
    });
});

// The real client against a local server: the stubs above cannot show that the download stops.
describe('get-dataset-items with a page far over the size limit', () => {
    const PAGE_BYTES = 64 * 1024 * 1024;

    it('stops the download near the limit and returns an input error naming limit, fields and omit', async () => {
        let sentBytes = 0;
        let requestUrl: string | undefined;
        const server = createServer((req, res) => {
            requestUrl = req.url;
            res.writeHead(200, { 'content-type': 'application/json', 'x-apify-pagination-total': '1' });
            res.write('[');
            const chunk = Buffer.from('"x",'.repeat(16 * 1024));
            const write = () => {
                while (sentBytes < PAGE_BYTES && !res.destroyed) {
                    sentBytes += chunk.length;
                    if (!res.write(chunk)) {
                        res.once('drain', write);
                        return;
                    }
                }
                if (!res.destroyed) res.end('"x"]');
            };
            write();
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

        try {
            const result = await (getDatasetItems as HelperTool).call(
                stubToolCallContext(
                    { datasetId: 'DsWkzbQMuFYuam3YF' },
                    new ApifyClient({ token: 'test-token', baseUrl, maxRetries: 0 }),
                ),
            );

            expectSoftFailInvalidInput(result);
            const { content } = result as TextToolResult;
            expect(content[0].text).toContain(`${MAX_INLINE_BYTES}-byte response limit`);
            expect(content[0].text).toContain('Lower `limit`, or use `fields` or `omit`');
            expect(requestUrl).toMatch(/^\/v2\/datasets\/DsWkzbQMuFYuam3YF\/items\?/);
            // Socket buffers hold some bytes past the limit; a full read would send all of them.
            expect(sentBytes).toBeLessThan(PAGE_BYTES / 4);
        } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });
});
