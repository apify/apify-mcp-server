import { describe, expect, it, vi } from 'vitest';

import { HelperTools } from '../../src/const.js';
import { getDataset } from '../../src/tools/common/get_dataset.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import { VERBATIM_LINKS_NUDGE } from '../../src/utils/console_link.js';
import { getUserInfoCached } from '../../src/utils/userid_cache.js';
import {
    expectSoftFailInvalidInput,
    mockUserInfo,
    stubToolCallContext,
    type TextToolResult,
} from './helpers/tool_context.js';

// Only Console UI token sessions reach the users/me lookup.
vi.mock('../../src/utils/userid_cache.js', () => ({
    getUserInfoCached: vi.fn(),
}));

const MOCK_DATASET = {
    id: 'ds-1',
    name: 'my-dataset',
    itemCount: 42,
    cleanItemCount: 42,
    fields: ['title', 'url'],
};

function stubApifyClient(dataset: unknown): InternalToolArgs['apifyClient'] {
    return {
        dataset: (_id: string) => ({ get: async () => dataset }),
    } as unknown as InternalToolArgs['apifyClient'];
}

describe('get-dataset', () => {
    it('has the expected tool name', () => {
        expect(getDataset.name).toBe(HelperTools.DATASET_GET);
    });

    it('returns dataset metadata plus a summary and nextStep in structuredContent', async () => {
        const result = await (getDataset as HelperTool).call(
            stubToolCallContext({ datasetId: 'ds-1' }, stubApifyClient(MOCK_DATASET)),
        );
        const { content, isError, structuredContent } = result as TextToolResult & {
            structuredContent: Record<string, unknown>;
        };

        expect(isError).not.toBe(true);
        // structuredContent preserves the metadata and adds the narrative fields.
        expect(structuredContent).toMatchObject(MOCK_DATASET);
        expect(structuredContent.summary).toBe("Dataset 'my-dataset' has 42 items, 2 fields.");
        expect(structuredContent.nextStep).toContain(HelperTools.DATASET_GET_ITEMS);
        expect(structuredContent.nextStep).toContain('datasetId=ds-1');
        // content[0] is the data-only JSON dump (no narrative); content[1] is the narrative.
        const { summary, nextStep, ...data } = structuredContent;
        expect(JSON.parse(content[0].text)).toEqual(data);
        expect(content[1].text).toBe(`${summary}\n${nextStep}`);
    });

    it('returns isError with a not-found message when the dataset does not exist', async () => {
        const result = await (getDataset as HelperTool).call(
            stubToolCallContext({ datasetId: 'missing' }, stubApifyClient(undefined)),
        );
        const { content } = result as TextToolResult;

        expectSoftFailInvalidInput(result);
        expect(content[0].text).toContain("Dataset 'missing' not found");
    });

    it('rejects empty datasetId via ajv validation', () => {
        const tool = getDataset as HelperTool;
        expect(tool.ajvValidate({ datasetId: '' })).toBe(false);
        expect(tool.ajvValidate({ datasetId: 'ds-1' })).toBe(true);
    });
});

/**
 * The Apify `/v2/datasets/{id}` endpoint returns `fields` slash-separated with
 * array indices expanded (e.g. `latestComments/0/owner/username`). The tool
 * normalizes to dot-notation and collapses pure-numeric segments so consumers
 * can feed the list straight into `get-dataset-items` as a `fields="..."`
 * projection. See PR #904 / issue #894.
 */
describe('get-dataset fields normalization', () => {
    it('translates slash-notation to dot-notation', async () => {
        const result = await (getDataset as HelperTool).call(
            stubToolCallContext(
                { datasetId: 'ds-1' },
                stubApifyClient({
                    id: 'ds-1',
                    itemCount: 1,
                    fields: ['crawl/httpStatusCode', 'metadata/url', 'markdown'],
                }),
            ),
        );
        const { structuredContent } = result as { structuredContent: { fields: string[] } };
        expect(structuredContent.fields).toEqual(['crawl.httpStatusCode', 'metadata.url', 'markdown']);
    });

    it('collapses array-index segments and dedupes', async () => {
        // Real-world shape from `apify/instagram-scraper`: Apify expands every array index,
        // bloating ~30 schema fields into hundreds of paths.
        const result = await (getDataset as HelperTool).call(
            stubToolCallContext(
                { datasetId: 'ds-1' },
                stubApifyClient({
                    id: 'ds-1',
                    itemCount: 1,
                    fields: [
                        'latestComments/0/id',
                        'latestComments/0/text',
                        'latestComments/1/id',
                        'latestComments/1/text',
                        'latestComments/2/owner/username',
                        'images/0',
                        'images/1',
                        'images/2',
                    ],
                }),
            ),
        );
        const { structuredContent } = result as { structuredContent: { fields: string[] } };
        expect(structuredContent.fields).toEqual([
            'latestComments.id',
            'latestComments.text',
            'latestComments.owner.username',
            'images',
        ]);
    });

    it('preserves non-`fields` keys from the raw API response unchanged', async () => {
        const raw = {
            id: 'ds-1',
            name: null,
            userId: 'u-1',
            itemCount: 3,
            stats: { storageBytes: 15557, readCount: 4, writeCount: 3 },
            fields: ['a/b/0/c', 'a/b/1/c'],
        };
        const result = await (getDataset as HelperTool).call(
            stubToolCallContext({ datasetId: 'ds-1' }, stubApifyClient(raw)),
        );
        const { structuredContent } = result as { structuredContent: Record<string, unknown> };
        expect(structuredContent).toMatchObject({
            id: 'ds-1',
            name: null,
            userId: 'u-1',
            itemCount: 3,
            stats: { storageBytes: 15557, readCount: 4, writeCount: 3 },
            fields: ['a.b.c'],
        });
    });

    it('passes through a response with no `fields` key untouched', async () => {
        const raw = { id: 'ds-empty', itemCount: 0 };
        const result = await (getDataset as HelperTool).call(
            stubToolCallContext({ datasetId: 'ds-empty' }, stubApifyClient(raw)),
        );
        const { structuredContent } = result as { structuredContent: Record<string, unknown> };
        expect(structuredContent).toMatchObject(raw);
        expect(structuredContent).not.toHaveProperty('fields');
    });

    it('appends the dataset Console link (from the API-returned id) for Console UI token sessions', async () => {
        vi.mocked(getUserInfoCached).mockResolvedValue(mockUserInfo());

        // Slug input — the link must use the API-returned id, not the slug.
        const result = await (getDataset as HelperTool).call({
            ...stubToolCallContext({ datasetId: 'user~my-dataset' }, stubApifyClient(MOCK_DATASET)),
            apifyToken: 'apify_ui_test',
        });
        const { content } = result as TextToolResult;

        // content: [0] data, [1] summary/nextStep, [2] Apify Console link.
        expect(content).toHaveLength(3);
        expect(content[2].text).toBe(
            `Apify Console: https://console.apify.com/storage/datasets/ds-1\n${VERBATIM_LINKS_NUDGE}`,
        );
    });
});
