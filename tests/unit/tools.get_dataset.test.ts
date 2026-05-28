import { describe, expect, it } from 'vitest';

import { HelperTools } from '../../src/const.js';
import { getDataset } from '../../src/tools/common/get_dataset.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import {
    expectSoftFailInvalidInput,
    parseFencedJson,
    stubToolCallContext,
    type TextToolResult,
} from './helpers/tool_context.js';

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

    it('returns dataset metadata as JSON in a fenced code block', async () => {
        const result = await (getDataset as HelperTool).call(
            stubToolCallContext({ datasetId: 'ds-1' }, stubApifyClient(MOCK_DATASET)),
        );
        const { content, isError } = result as TextToolResult;

        expect(isError).not.toBe(true);
        expect(parseFencedJson(content[0].text)).toEqual(MOCK_DATASET);
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
        const { content } = result as TextToolResult;
        expect((parseFencedJson(content[0].text) as { fields: string[] }).fields).toEqual([
            'crawl.httpStatusCode',
            'metadata.url',
            'markdown',
        ]);
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
        const { content } = result as TextToolResult;
        expect((parseFencedJson(content[0].text) as { fields: string[] }).fields).toEqual([
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
        const { content } = result as TextToolResult;
        expect(parseFencedJson(content[0].text)).toEqual({
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
        const { content } = result as TextToolResult;
        const json = parseFencedJson(content[0].text) as Record<string, unknown>;
        expect(json).toEqual(raw);
        expect(json).not.toHaveProperty('fields');
    });
});
