import { describe, expect, it } from 'vitest';

import { getDataset } from '../../src/tools/common/get_dataset.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';

/**
 * `get-dataset` dumps the raw Apify API response as JSON. The Apify dataset
 * `/v2/datasets/{id}` endpoint returns `fields` slash-separated with array
 * indices expanded (e.g. `latestComments/0/owner/username`); the tool normalizes
 * to dot-notation and collapses pure-numeric segments so consumers can feed
 * the list straight into `get-dataset-items` as a `fields="..."` projection.
 *
 * See PR #904 / issue #894.
 */

function stubApifyClient(datasetGet: () => Promise<unknown>): InternalToolArgs['apifyClient'] {
    return {
        dataset: (_id: string) => ({ get: datasetGet }),
    } as unknown as InternalToolArgs['apifyClient'];
}

function stubArgs(args: Record<string, unknown>, datasetGet: () => Promise<unknown>): InternalToolArgs {
    return {
        args,
        apifyToken: 'test-token',
        apifyClient: stubApifyClient(datasetGet),
        extra: {} as InternalToolArgs['extra'],
        mcpServer: {} as InternalToolArgs['mcpServer'],
        apifyMcpServer: { options: { paymentProvider: undefined } } as InternalToolArgs['apifyMcpServer'],
    } as InternalToolArgs;
}

function extractJson(result: unknown): Record<string, unknown> {
    const { content } = result as { content: { type: string; text: string }[] };
    const [{ text }] = content;
    const match = text.match(/```json\n([\s\S]*?)\n```/);
    if (!match) throw new Error(`Tool output did not contain a json code block: ${text}`);
    return JSON.parse(match[1]) as Record<string, unknown>;
}

describe('get-dataset fields normalization', () => {
    it('translates slash-notation to dot-notation', async () => {
        const result = await (getDataset as HelperTool).call(
            stubArgs(
                { datasetId: 'ds-1' },
                async () => ({ id: 'ds-1', itemCount: 1, fields: ['crawl/httpStatusCode', 'metadata/url', 'markdown'] }),
            ),
        );
        expect(extractJson(result).fields).toEqual(['crawl.httpStatusCode', 'metadata.url', 'markdown']);
    });

    it('collapses array-index segments and dedupes', async () => {
        // Real-world shape from `apify/instagram-scraper`: Apify expands every array index,
        // bloating ~30 schema fields into hundreds of paths.
        const result = await (getDataset as HelperTool).call(
            stubArgs(
                { datasetId: 'ds-1' },
                async () => ({
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
        expect(extractJson(result).fields).toEqual([
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
        const json = extractJson(
            await (getDataset as HelperTool).call(stubArgs({ datasetId: 'ds-1' }, async () => raw)),
        );
        expect(json).toEqual({
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
        const json = extractJson(
            await (getDataset as HelperTool).call(stubArgs({ datasetId: 'ds-empty' }, async () => raw)),
        );
        expect(json).toEqual(raw);
        expect(json).not.toHaveProperty('fields');
    });

    it('returns a soft-fail error when the dataset does not exist', async () => {
        const result = await (getDataset as HelperTool).call(
            stubArgs({ datasetId: 'missing' }, async () => null),
        );
        const { isError, content } = result as { isError?: boolean; content: { text: string }[] };
        const [{ text }] = content;
        expect(isError).toBe(true);
        expect(text).toContain("Dataset 'missing' not found");
    });
});
