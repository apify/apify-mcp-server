import { describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { getDatasetList } from '../../src/tools/storage/get_dataset_list.js';
import { storageListOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import {
    expectSchemaConformingStructuredContent,
    stubToolCallContext,
    type TextToolResult,
} from './helpers/tool_context.js';

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
        expect(getDatasetList.name).toBe(HELPER_TOOLS.DATASET_LIST_GET);
    });

    it('returns the list response plus a summary and nextStep in structuredContent', async () => {
        const listSpy = vi.fn().mockResolvedValue(MOCK_LIST);

        const result = await (getDatasetList as HelperTool).call(stubToolCallContext({}, stubApifyClient(listSpy)));
        const { content, structuredContent } = result as TextToolResult & {
            structuredContent: Record<string, unknown>;
        };

        expect(structuredContent).toMatchObject(MOCK_LIST);
        expect(structuredContent.summary).toBe('Listed 2 of 2 datasets.');
        // Not truncated → nextStep points at inspecting a dataset, not pagination.
        expect(structuredContent.nextStep).toContain(HELPER_TOOLS.DATASET_GET);
        // content[0] ships the JSON data; content[1] carries the prose summary + nextStep.
        const { summary, nextStep, ...data } = structuredContent;
        expect(JSON.parse(content[0].text)).toEqual(data);
        expect(content[1].text).toBe(`${summary}\n${nextStep}`);
    });

    it('preserves each dataset stats.inflatedBytes in structuredContent', async () => {
        const listSpy = vi.fn().mockResolvedValue({
            ...MOCK_LIST,
            items: [
                { id: 'ds-1', name: 'a', itemCount: 5, stats: { inflatedBytes: 54385 } },
                { id: 'ds-2', name: 'b', itemCount: 0, stats: { inflatedBytes: 0 } },
            ],
        });

        const result = await (getDatasetList as HelperTool).call(stubToolCallContext({}, stubApifyClient(listSpy)));
        const { structuredContent } = result as {
            structuredContent: { items: { stats: { inflatedBytes: number } }[] };
        };

        expect(structuredContent.items[0].stats.inflatedBytes).toBe(54385);
    });

    it('emits a pagination nextStep when more datasets remain', async () => {
        const listSpy = vi.fn().mockResolvedValue({ ...MOCK_LIST, total: 25 });

        const result = await (getDatasetList as HelperTool).call(stubToolCallContext({}, stubApifyClient(listSpy)));
        const { structuredContent } = result as { structuredContent: Record<string, unknown> };

        expect(structuredContent.summary).toBe('Listed 2 of 25 datasets.');
        expect(structuredContent.nextStep).toBe(
            `Call ${HELPER_TOOLS.DATASET_LIST_GET} again with offset=2 to fetch the next page.`,
        );
    });

    it('forwards pagination params (limit, offset, desc, unnamed) to ApifyClient', async () => {
        const listSpy = vi.fn().mockResolvedValue(MOCK_LIST);

        await (getDatasetList as HelperTool).call(
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

        await (getDatasetList as HelperTool).call(stubToolCallContext({}, stubApifyClient(listSpy)));

        expect(listSpy).toHaveBeenCalledWith({ limit: 10, offset: 0, desc: false, unnamed: false });
    });

    it('emits structuredContent that validates against the outputSchema for the last/empty page', async () => {
        const listSpy = vi.fn().mockResolvedValue({ ...MOCK_LIST, total: 0, count: 0, items: [] });

        const result = await (getDatasetList as HelperTool).call(stubToolCallContext({}, stubApifyClient(listSpy)));
        const { structuredContent } = result as { structuredContent: Record<string, unknown> };

        expect(structuredContent).toHaveProperty('count', 0);
        expectSchemaConformingStructuredContent(result, storageListOutputSchema);
    });

    it('rejects limit above 20 via ajv validation', () => {
        const tool = getDatasetList as HelperTool;
        expect(tool.ajvValidate({ limit: 21 })).toBe(false);
        expect(tool.ajvValidate({ limit: 20 })).toBe(true);
    });
});
