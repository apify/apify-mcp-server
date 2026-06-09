import { describe, expect, it, vi } from 'vitest';

import { HelperTools } from '../../src/const.js';
import { getUserDatasetsList } from '../../src/tools/common/dataset_collection.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import { decodeFencedToolText, stubToolCallContext, type TextToolResult } from './helpers/tool_context.js';

const MOCK_LIST = {
    total: 2,
    offset: 0,
    limit: 10,
    desc: false,
    count: 2,
    items: [
        { id: 'ds-1', name: 'a' },
        { id: 'ds-2', name: 'b' },
    ],
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

    it('returns the list response plus a summary and nextStep in structuredContent', async () => {
        const listSpy = vi.fn().mockResolvedValue(MOCK_LIST);

        const result = await (getUserDatasetsList as HelperTool).call(
            stubToolCallContext({}, stubApifyClient(listSpy)),
        );
        const { content, structuredContent } = result as TextToolResult & {
            structuredContent: Record<string, unknown>;
        };

        expect(structuredContent).toMatchObject(MOCK_LIST);
        expect(structuredContent.summary).toBe('Listed 2 of 2 datasets.');
        // Not truncated → nextStep points at inspecting a dataset, not pagination.
        expect(structuredContent.nextStep).toContain(HelperTools.DATASET_GET);
        // content[0] ships TOON (or JSON fallback) and round-trips to the full structuredContent.
        expect(decodeFencedToolText(content[0].text)).toEqual(structuredContent);
        expect(content[1].text).toBe(`${structuredContent.summary}\n${structuredContent.nextStep}`);
    });

    it('emits a pagination nextStep when more datasets remain', async () => {
        const listSpy = vi.fn().mockResolvedValue({ ...MOCK_LIST, total: 25 });

        const result = await (getUserDatasetsList as HelperTool).call(
            stubToolCallContext({}, stubApifyClient(listSpy)),
        );
        const { structuredContent } = result as { structuredContent: Record<string, unknown> };

        expect(structuredContent.summary).toBe('Listed 2 of 25 datasets.');
        expect(structuredContent.nextStep).toBe(
            `Call ${HelperTools.DATASET_LIST_GET} again with offset=2 to fetch the next page.`,
        );
    });

    it('forwards pagination params (limit, offset, desc, unnamed) to ApifyClient', async () => {
        const listSpy = vi.fn().mockResolvedValue(MOCK_LIST);

        await (getUserDatasetsList as HelperTool).call(
            stubToolCallContext(
                {
                    limit: 5,
                    offset: 10,
                    desc: true,
                    unnamed: true,
                },
                stubApifyClient(listSpy),
            ),
        );

        expect(listSpy).toHaveBeenCalledWith({ limit: 5, offset: 10, desc: true, unnamed: true });
    });

    it('applies defaults (limit=10, offset=0, desc=false, unnamed=false) when no params given', async () => {
        const listSpy = vi.fn().mockResolvedValue(MOCK_LIST);

        await (getUserDatasetsList as HelperTool).call(stubToolCallContext({}, stubApifyClient(listSpy)));

        expect(listSpy).toHaveBeenCalledWith({ limit: 10, offset: 0, desc: false, unnamed: false });
    });

    it('rejects limit above 20 via ajv validation', () => {
        const tool = getUserDatasetsList as HelperTool;
        expect(tool.ajvValidate({ limit: 21 })).toBe(false);
        expect(tool.ajvValidate({ limit: 20 })).toBe(true);
    });
});
