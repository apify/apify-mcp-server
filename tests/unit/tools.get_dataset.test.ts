// Per-file stubs match the repo convention; see tools.get_dataset_items.test.ts.
import { describe, expect, it } from 'vitest';

import { getDataset } from '../../src/tools/common/get_dataset.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';

const MOCK_DATASET = {
    id: 'ds-1',
    name: 'my-dataset',
    itemCount: 42,
    cleanItemCount: 42,
    fields: ['title', 'url'],
};

function stubApifyClient(dataset: unknown): InternalToolArgs['apifyClient'] {
    return {
        dataset: (_id: string) => ({
            get: async () => dataset,
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

describe('get-dataset', () => {
    it('returns dataset metadata as JSON in a fenced code block', async () => {
        const result = await (getDataset as HelperTool).call(
            stubArgs({ datasetId: 'ds-1' }, stubApifyClient(MOCK_DATASET)),
        );
        const { content, isError } = result as { content: { type: string; text: string }[]; isError?: boolean };

        expect(isError).not.toBe(true);
        expect(content).toHaveLength(1);
        expect(content[0].type).toBe('text');
        expect(content[0].text).toMatch(/^```json\n/);
        expect(content[0].text).toMatch(/\n```$/);
        const json = content[0].text.replace(/^```json\n/, '').replace(/\n```$/, '');
        expect(JSON.parse(json)).toEqual(MOCK_DATASET);
    });

    it('returns isError with a not-found message when the dataset does not exist', async () => {
        const result = await (getDataset as HelperTool).call(
            stubArgs({ datasetId: 'missing' }, stubApifyClient(undefined)),
        );
        const { content, isError } = result as { content: { text: string }[]; isError?: boolean };

        expect(isError).toBe(true);
        expect(content[0].text).toContain("Dataset 'missing' not found");
    });

    it('rejects empty datasetId via ajv validation', () => {
        const tool = getDataset as HelperTool;
        expect(tool.ajvValidate({ datasetId: '' })).toBe(false);
        expect(tool.ajvValidate({ datasetId: 'ds-1' })).toBe(true);
    });
});
