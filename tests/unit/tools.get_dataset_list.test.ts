import { describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { getDatasetList } from '../../src/tools/storage/get_dataset_list.js';
import { storageListOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import {
    expectSchemaConformingStructuredContent,
    mockApifyClient,
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
    return mockApifyClient({
        datasets: () => ({ list: listSpy }),
    });
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
        expect(structuredContent.summary).toBe('Listed 2 of 2 named datasets.');
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

        expect(structuredContent.summary).toBe('Listed 2 of 25 named datasets.');
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

    it('leaves "named" out of the summary with unnamed=true', async () => {
        const listSpy = vi.fn().mockResolvedValue(MOCK_LIST);

        const result = await (getDatasetList as HelperTool).call(
            stubToolCallContext({ unnamed: true }, stubApifyClient(listSpy)),
        );
        const { structuredContent } = result as { structuredContent: Record<string, unknown> };

        expect(structuredContent.summary).toBe('Listed 2 of 2 datasets.');
        expect(structuredContent.nextStep).toBe(
            `Use ${HELPER_TOOLS.DATASET_GET} with a datasetId from the list to inspect a dataset.`,
        );
    });

    it.each([
        [
            false,
            0,
            0,
            'Listed 0 of 0 named datasets.',
            'unnamed=true includes the unnamed datasets that Actor runs create.',
        ],
        [
            false,
            5,
            20,
            'Listed 0 of 5 named datasets.',
            'unnamed=true includes the unnamed datasets that Actor runs create.',
        ],
        [true, 0, 0, 'Listed 0 of 0 datasets.', 'No follow-up step.'],
    ])(
        'returns the empty-last-page nextStep for unnamed=%s (total=%i, offset=%i)',
        async (unnamed, total, offset, summary, nextStep) => {
            const listSpy = vi.fn().mockResolvedValue({ ...MOCK_LIST, total, offset, count: 0, items: [] });

            const result = await (getDatasetList as HelperTool).call(
                stubToolCallContext({ unnamed }, stubApifyClient(listSpy)),
            );
            const { content, structuredContent } = result as TextToolResult & {
                structuredContent: Record<string, unknown>;
            };

            expect(structuredContent.summary).toBe(summary);
            expect(structuredContent.nextStep).toBe(nextStep);
            expect(content[1].text).toBe(`${summary}\n${nextStep}`);
            expectSchemaConformingStructuredContent(result, storageListOutputSchema);
        },
    );

    // Regression: #1479 — the API reads limit=0 as no limit and returns up to 1,000 items.
    it.each([0, -1, 1.5, 21])('rejects limit %s via ajv validation', (limit) => {
        expect((getDatasetList as HelperTool).ajvValidate({ limit })).toBe(false);
    });

    it.each([{ limit: 1 }, { limit: 20 }, {}])('accepts %j via ajv validation', (args) => {
        expect((getDatasetList as HelperTool).ajvValidate(args)).toBe(true);
    });

    // Regression: #1296 — the terminal nextStep named a sibling tool the session was not served.
    it('falls back on the last page when get-dataset is not loaded', async () => {
        const result = (await (getDatasetList as HelperTool).call(
            stubToolCallContext({}, stubApifyClient(vi.fn().mockResolvedValue(MOCK_LIST)), {
                loadedToolNames: [HELPER_TOOLS.DATASET_LIST_GET],
            }),
        )) as TextToolResult & { structuredContent: Record<string, unknown> };

        expect(result.structuredContent.nextStep).toBe('No follow-up step.');
        expect(JSON.stringify([result.content, result.structuredContent])).not.toContain(HELPER_TOOLS.DATASET_GET);
        expectSchemaConformingStructuredContent(result, storageListOutputSchema);
    });
});
