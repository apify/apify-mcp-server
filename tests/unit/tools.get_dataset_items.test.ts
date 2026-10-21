import { describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { getApiFields, getDatasetItems, projectFields } from '../../src/tools/storage/get_dataset_items.js';
import { datasetItemsOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import { VERBATIM_LINKS_NUDGE } from '../../src/utils/console_link.js';
import { getUserInfoCached } from '../../src/utils/userid_cache.js';
import {
    expectSchemaConformingStructuredContent,
    expectSoftFailInvalidInput,
    mockApifyClient,
    mockUserInfo,
    stubToolCallContext,
    type TextToolResult,
} from './helpers/tool_context.js';

// Only Console UI token sessions reach the users/me lookup.
vi.mock('../../src/utils/userid_cache.js', () => ({
    getUserInfoCached: vi.fn(),
}));

// One apify/web-search item: a nested object and an array of objects.
const WEB_SEARCH_ITEM = {
    query: 'apify mcp',
    search: { provider: 'google', page: 1 },
    results: [
        { position: 1, url: 'https://mcp.apify.com/', title: 'Apify MCP', snippet: 'Connect agents' },
        { position: 2, url: 'https://docs.apify.com/', title: 'Docs' },
    ],
};

describe('projectFields keeps the item nesting', () => {
    it('keeps a top-level field whole', () => {
        expect(projectFields(WEB_SEARCH_ITEM, ['search'])).toEqual({ search: WEB_SEARCH_ITEM.search });
    });

    it('projects a nested object path', () => {
        expect(projectFields(WEB_SEARCH_ITEM, ['search.provider'])).toEqual({ search: { provider: 'google' } });
    });

    it('maps an array of objects element-wise, keeping positions', () => {
        const item = {
            results: [{ url: 'https://mcp.apify.com/' }, { title: 'No URL' }, { url: 'https://apify.com/' }],
        };
        expect(projectFields(item, ['results.url'])).toEqual({
            results: [{ url: 'https://mcp.apify.com/' }, {}, { url: 'https://apify.com/' }],
        });
    });

    it('merges two paths under one array', () => {
        expect(projectFields(WEB_SEARCH_ITEM, ['results.url', 'results.title'])).toEqual({
            results: [
                { url: 'https://mcp.apify.com/', title: 'Apify MCP' },
                { url: 'https://docs.apify.com/', title: 'Docs' },
            ],
        });
    });

    it('maps an array nested inside an array of objects', () => {
        const item = {
            results: [{ title: 'Docs', siteLinks: [{ url: 'https://docs.apify.com/a', text: 'A' }, { text: 'B' }] }],
        };
        expect(projectFields(item, ['results.siteLinks.url'])).toEqual({
            results: [{ siteLinks: [{ url: 'https://docs.apify.com/a' }, {}] }],
        });
    });

    it('keeps the whole value when a path and its parent are both requested, in either order', () => {
        expect(projectFields(WEB_SEARCH_ITEM, ['search.provider', 'search'])).toEqual({
            search: WEB_SEARCH_ITEM.search,
        });
        expect(projectFields(WEB_SEARCH_ITEM, ['search', 'search.provider'])).toEqual({
            search: WEB_SEARCH_ITEM.search,
        });
    });

    it('adds an index path to that element next to an every-element path on the same array', () => {
        expect(projectFields(WEB_SEARCH_ITEM, ['results.url', 'results.0.title'])).toEqual({
            results: [{ url: 'https://mcp.apify.com/', title: 'Apify MCP' }, { url: 'https://docs.apify.com/' }],
        });
    });

    it('picks one array element by a numeric segment, keeping its position', () => {
        expect(projectFields(WEB_SEARCH_ITEM, ['results.1.url'])).toEqual({
            results: [{}, { url: 'https://docs.apify.com/' }],
        });
    });

    it('returns a whole element picked by a numeric segment, with {} before it', () => {
        expect(projectFields(WEB_SEARCH_ITEM, ['results.1'])).toEqual({
            results: [{}, WEB_SEARCH_ITEM.results[1]],
        });
    });

    it('keeps the place of an element that is not an object as null', () => {
        const item = { latestComments: [{ text: 'Great post' }, null, 'deleted'] };
        expect(projectFields(item, ['latestComments.text'])).toEqual({
            latestComments: [{ text: 'Great post' }, null, null],
        });
    });

    it('omits an absent path and returns {} when nothing matches', () => {
        expect(projectFields(WEB_SEARCH_ITEM, ['query', 'search.missing', 'results.missing'])).toEqual({
            query: 'apify mcp',
        });
        expect(projectFields(WEB_SEARCH_ITEM, ['query.length', 'missing'])).toEqual({});
    });

    it('orders keys by fields', () => {
        expect(Object.keys(projectFields(WEB_SEARCH_ITEM, ['results.url', 'query', 'search.provider']))).toEqual([
            'results',
            'query',
            'search',
        ]);
    });

    it('returns a literal dotted key the item holds instead of the nested path', () => {
        const item = { 'metadata.url': 'https://apify.com/', metadata: { url: 'https://docs.apify.com/' } };
        expect(projectFields(item, ['metadata.url'])).toEqual({ 'metadata.url': 'https://apify.com/' });
    });
});

describe('getApiFields requests what the projection needs', () => {
    it('requests the top-level key of each path and each path as written', () => {
        expect(getApiFields(['results.url', 'query', 'results.title'])).toEqual([
            'results',
            'query',
            'results.url',
            'results.title',
        ]);
    });
});

const MOCK_ITEMS = [{ first_number: 3, second_number: 4, sum: 7 }];
const MANY_ITEMS = Array.from({ length: 20 }, (_, i) => ({ n: i }));

function stubApifyClient(
    listItems: (...args: unknown[]) => unknown = async () => ({ items: MOCK_ITEMS, total: 1 }),
): InternalToolArgs['apifyClient'] {
    return mockApifyClient({
        dataset: (_id: string) => ({ listItems }),
    });
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

    it('sends the API top-level fields without flatten and projects dotted paths on the items', async () => {
        const listItemsSpy = vi.fn().mockResolvedValue({ items: [WEB_SEARCH_ITEM], total: 1 });

        const result = await (getDatasetItems as HelperTool).call(
            stubToolCallContext(
                { datasetId: 'ds-1', fields: 'results.url,query', flatten: 'results' },
                stubApifyClient(listItemsSpy),
            ),
        );

        const options = listItemsSpy.mock.calls[0][0] as Record<string, unknown>;
        expect(options.fields).toEqual(getApiFields(['results.url', 'query']));
        expect(options).not.toHaveProperty('flatten');
        const { structuredContent } = result as { structuredContent: { items: unknown[] } };
        expect(structuredContent.items).toEqual([
            {
                results: [{ url: 'https://mcp.apify.com/' }, { url: 'https://docs.apify.com/' }],
                query: 'apify mcp',
            },
        ]);
    });

    it('names in the summary, once, only the fields that matched no item on the page', async () => {
        const result = await (getDatasetItems as HelperTool).call(
            stubToolCallContext(
                { datasetId: 'ds-1', fields: 'results.url,results.link,results.link' },
                stubApifyClient(async () => ({ items: [WEB_SEARCH_ITEM], total: 1 })),
            ),
        );
        const { structuredContent } = result as { structuredContent: { summary: string } };

        expect(structuredContent.summary).toContain('No item on this page has results.link.');
        expect(structuredContent.summary).not.toContain('results.url');
    });

    it('names no unmatched field that the caller also omits', async () => {
        const result = await (getDatasetItems as HelperTool).call(
            stubToolCallContext(
                { datasetId: 'ds-1', fields: 'results.url,query', omit: 'results' },
                stubApifyClient(async () => ({ items: [{ query: 'apify mcp' }], total: 1 })),
            ),
        );
        const { structuredContent } = result as { structuredContent: { summary: string } };

        expect(structuredContent.summary).not.toContain('No item on this page has');
    });

    it('ignores a field made of dots only', async () => {
        const listItemsSpy = vi.fn().mockResolvedValue({ items: [WEB_SEARCH_ITEM], total: 1 });

        const result = await (getDatasetItems as HelperTool).call(
            stubToolCallContext({ datasetId: 'ds-1', fields: '.,query' }, stubApifyClient(listItemsSpy)),
        );

        expect(listItemsSpy.mock.calls[0][0]).toEqual(expect.objectContaining({ fields: ['query'] }));
        const { structuredContent } = result as { structuredContent: { items: unknown[]; summary: string } };
        expect(structuredContent.items).toEqual([{ query: 'apify mcp' }]);
        expect(structuredContent.summary).not.toContain('No item on this page has');
    });

    it('names no unmatched fields when the page is empty', async () => {
        const result = await (getDatasetItems as HelperTool).call(
            stubToolCallContext(
                { datasetId: 'ds-1', fields: 'results.url' },
                stubApifyClient(async () => ({ items: [], total: 0 })),
            ),
        );
        const { structuredContent } = result as { structuredContent: { summary: string } };

        expect(structuredContent.summary).not.toContain('No item on this page has');
    });

    it('rejects empty datasetId via ajv validation', () => {
        const tool = getDatasetItems as HelperTool;
        expect(tool.ajvValidate({ datasetId: '' })).toBe(false);
        expect(tool.ajvValidate({ datasetId: 'ds-1' })).toBe(true);
    });

    it('passes the wrapper-stripped datasetId to client.dataset()', async () => {
        const datasetSpy = vi.fn().mockReturnValue({ listItems: async () => ({ items: MOCK_ITEMS, total: 1 }) });
        const client = mockApifyClient({ dataset: datasetSpy });

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
