import { describe, expect, it, vi } from 'vitest';

import { HelperTools } from '../../src/const.js';
import { getUserDatasetsList } from '../../src/tools/common/dataset_collection.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import { parseFencedJson, stubToolCallContext, type TextToolResult } from './helpers/tool_context.js';

const MOCK_LIST = {
    total: 2,
    offset: 0,
    limit: 10,
    desc: false,
    count: 2,
    items: [{ id: 'ds-1', name: 'a' }, { id: 'ds-2', name: 'b' }],
};

function stubApifyClient(listSpy: ReturnType<typeof vi.fn>): InternalToolArgs['apifyClient'] {
    return {
        datasets: () => ({ list: listSpy }),
    } as unknown as InternalToolArgs['apifyClient'];
}

describe('get-dataset-list', () => {
    it('has the expected tool name', () => {
        expect(getUserDatasetsList.name).toBe(HelperTools.DATASET_LIST_GET);
    });

    it('returns the list response as JSON in a fenced code block', async () => {
        const listSpy = vi.fn().mockResolvedValue(MOCK_LIST);

        const result = await (getUserDatasetsList as HelperTool).call(
            stubToolCallContext({}, stubApifyClient(listSpy)),
        );
        const { content } = result as TextToolResult;

        expect(parseFencedJson(content[0].text)).toEqual(MOCK_LIST);
    });

    it('forwards pagination params (limit, offset, desc, unnamed) to ApifyClient', async () => {
        const listSpy = vi.fn().mockResolvedValue(MOCK_LIST);

        await (getUserDatasetsList as HelperTool).call(stubToolCallContext({
            limit: 5,
            offset: 10,
            desc: true,
            unnamed: true,
        }, stubApifyClient(listSpy)));

        expect(listSpy).toHaveBeenCalledWith({ limit: 5, offset: 10, desc: true, unnamed: true });
    });

    it('applies defaults (limit=10, offset=0, desc=false, unnamed=false) when no params given', async () => {
        const listSpy = vi.fn().mockResolvedValue(MOCK_LIST);

        await (getUserDatasetsList as HelperTool).call(
            stubToolCallContext({}, stubApifyClient(listSpy)),
        );

        expect(listSpy).toHaveBeenCalledWith({ limit: 10, offset: 0, desc: false, unnamed: false });
    });

    it('rejects limit above 20 via ajv validation', () => {
        const tool = getUserDatasetsList as HelperTool;
        expect(tool.ajvValidate({ limit: 21 })).toBe(false);
        expect(tool.ajvValidate({ limit: 20 })).toBe(true);
    });
});
