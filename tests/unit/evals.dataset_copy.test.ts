import type { LangfuseClient } from '@langfuse/client';
import { describe, expect, it } from 'vitest';

import type { McpAgentItem } from '../../evals/langfuse/dataset.js';
import { copyCasesToDataset } from '../../evals/langfuse/dataset_copy.js';

function makeItem(id: string, query = 'Find an Actor that scrapes Google Maps'): McpAgentItem {
    return {
        id,
        input: { query },
        expectedOutput: undefined,
        metadata: { category: 'search-actors', kind: 'tool-call', expectedTools: ['search-actors'] },
    };
}

/** Langfuse client whose dataset holds the given hosted items and records every item write. */
function makeLangfuseClient(hostedItems: { id: string; status: string; sourceTraceId?: string }[], failOnId?: string) {
    const writes: Record<string, unknown>[] = [];
    const client = {
        dataset: {
            get: async () => ({
                id: 'dataset-123',
                items: hostedItems.map((hosted) => ({ ...makeItem(hosted.id, 'hosted text'), ...hosted })),
            }),
        },
        api: {
            datasetItems: {
                create: async (request: Record<string, unknown>) => {
                    if (request.id === failOnId) throw new Error('503 Service Unavailable');
                    writes.push(request);
                },
            },
        },
    } as unknown as LangfuseClient;
    return { client, writes };
}

describe('copying case files into a dataset', () => {
    it('writes one active item per case under the case id, with the text from the file', async () => {
        const { client, writes } = makeLangfuseClient([]);
        const item = makeItem('pr/search-actors/find-scraper');

        const result = await copyCasesToDataset(client, 'mcp-server-evals-pr', [item]);

        expect(writes).toEqual([
            {
                datasetName: 'mcp-server-evals-pr',
                id: item.id,
                input: item.input,
                expectedOutput: item.expectedOutput,
                metadata: item.metadata,
                status: 'ACTIVE',
            },
        ]);
        expect(result).toEqual({ datasetId: 'dataset-123', archivedIds: [] });
    });

    it('archives an active hosted item whose id is not in the files, keeping its content', async () => {
        const { client, writes } = makeLangfuseClient([
            { id: 'pr/search-actors/find-scraper', status: 'ACTIVE' },
            { id: 'pr/search-actors/removed', status: 'ACTIVE', sourceTraceId: 'trace-1' },
        ]);

        const result = await copyCasesToDataset(client, 'mcp-server-evals-pr', [
            makeItem('pr/search-actors/find-scraper'),
        ]);

        expect(result.archivedIds).toEqual(['pr/search-actors/removed']);
        expect(writes[1]).toMatchObject({
            id: 'pr/search-actors/removed',
            input: { query: 'hosted text' },
            sourceTraceId: 'trace-1',
            status: 'ARCHIVED',
        });
    });

    it('leaves an already archived hosted item alone', async () => {
        const { client, writes } = makeLangfuseClient([{ id: 'pr/search-actors/retired', status: 'ARCHIVED' }]);

        const result = await copyCasesToDataset(client, 'mcp-server-evals-pr', [
            makeItem('pr/search-actors/find-scraper'),
        ]);

        expect(result.archivedIds).toEqual([]);
        expect(writes.map((write) => write.id)).toEqual(['pr/search-actors/find-scraper']);
    });

    // The caller starts the experiment only after the copy resolves, so a rejection stops the run.
    it('rejects when a write fails, before anything is archived', async () => {
        const { client, writes } = makeLangfuseClient(
            [{ id: 'pr/search-actors/removed', status: 'ACTIVE' }],
            'pr/search-actors/second',
        );

        await expect(
            copyCasesToDataset(client, 'mcp-server-evals-pr', [
                makeItem('pr/search-actors/first'),
                makeItem('pr/search-actors/second'),
            ]),
        ).rejects.toThrow(/pr\/search-actors\/second.*503/s);
        expect(writes.map((write) => write.status)).toEqual(['ACTIVE']);
    });
});
