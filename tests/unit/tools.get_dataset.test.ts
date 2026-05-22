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
