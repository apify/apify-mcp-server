// Per-file stubs match the repo convention; see tools.get_dataset_items.test.ts.
import { describe, expect, it } from 'vitest';

import { getDatasetSchema } from '../../src/tools/common/get_dataset_schema.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';

const MOCK_ITEMS = [
    { title: 'a', count: 1 },
    { title: 'b', count: 2 },
];

function stubApifyClient(listItemsResponse: unknown): InternalToolArgs['apifyClient'] {
    return {
        dataset: (_id: string) => ({
            listItems: async () => listItemsResponse,
        }),
    } as unknown as InternalToolArgs['apifyClient'];
}

function stubArgs(args: Record<string, unknown>, client: InternalToolArgs['apifyClient']): InternalToolArgs {
    return {
        args,
        apifyToken: 'test-token',
        apifyClient: client,
        extra: {} as InternalToolArgs['extra'],
        mcpServer: {} as InternalToolArgs['mcpServer'],
        apifyMcpServer: { options: { paymentProvider: undefined } } as InternalToolArgs['apifyMcpServer'],
    } as InternalToolArgs;
}

describe('get-dataset-schema', () => {
    it('returns a JSON schema in a fenced code block on the happy path', async () => {
        const result = await (getDatasetSchema as HelperTool).call(
            stubArgs({ datasetId: 'ds-1' }, stubApifyClient({ items: MOCK_ITEMS, total: 2 })),
        );
        const { content, isError } = result as { content: { text: string }[]; isError?: boolean };

        expect(isError).not.toBe(true);
        expect(content[0].text).toMatch(/^```json\n/);
        const json = content[0].text.replace(/^```json\n/, '').replace(/\n```$/, '');
        const schema = JSON.parse(json);
        // The generated schema describes an array of objects with the input fields.
        expect(schema).toMatchObject({ type: 'array' });
    });

    it('returns a plain "is empty" message when the dataset has no items', async () => {
        const result = await (getDatasetSchema as HelperTool).call(
            stubArgs({ datasetId: 'ds-1' }, stubApifyClient({ items: [], total: 0 })),
        );
        const { content, isError } = result as { content: { text: string }[]; isError?: boolean };

        expect(isError).not.toBe(true);
        expect(content[0].text).toBe("Dataset 'ds-1' is empty.");
    });

    it('returns isError with a not-found message when listItems returns no response', async () => {
        const result = await (getDatasetSchema as HelperTool).call(
            stubArgs({ datasetId: 'missing' }, stubApifyClient(null)),
        );
        const { content, isError } = result as { content: { text: string }[]; isError?: boolean };

        expect(isError).toBe(true);
        expect(content[0].text).toContain("Dataset 'missing' not found");
    });
});
