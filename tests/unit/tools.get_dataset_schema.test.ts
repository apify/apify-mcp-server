import { describe, expect, it, vi } from 'vitest';

import { FAILURE_CATEGORY, HelperTools, TOOL_STATUS } from '../../src/const.js';
import { getDatasetSchema } from '../../src/tools/common/get_dataset_schema.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import type * as SchemaGenModule from '../../src/utils/schema_generation.js';
import { generateSchemaFromItems } from '../../src/utils/schema_generation.js';
import {
    expectSoftFailInvalidInput,
    stubToolCallContext,
    type TextToolResult,
    type ToolTelemetrySnapshot,
} from './helpers/tool_context.js';

vi.mock('../../src/utils/schema_generation.js', async (importOriginal) => {
    const actual = await importOriginal<typeof SchemaGenModule>();
    return {
        ...actual,
        generateSchemaFromItems: vi.fn(actual.generateSchemaFromItems),
    };
});

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

function stubApifyClientThrowing(err: unknown): InternalToolArgs['apifyClient'] {
    return {
        dataset: (_id: string) => ({
            listItems: async () => {
                throw err;
            },
        }),
    } as unknown as InternalToolArgs['apifyClient'];
}

describe('get-dataset-schema', () => {
    it('has the expected tool name', () => {
        expect(getDatasetSchema.name).toBe(HelperTools.DATASET_SCHEMA_GET);
    });

    it('returns the inferred schema plus a summary and nextStep on the happy path', async () => {
        const result = await (getDatasetSchema as HelperTool).call(
            stubToolCallContext({ datasetId: 'ds-1' }, stubApifyClient({ items: MOCK_ITEMS, total: 2 })),
        );
        const { content, isError, structuredContent } = result as TextToolResult & {
            structuredContent: Record<string, unknown>;
        };

        expect(isError).not.toBe(true);
        expect(structuredContent.datasetId).toBe('ds-1');
        expect(structuredContent.schema).toMatchObject({ type: 'array' });
        // MOCK_ITEMS has 2 items, each with 2 fields (title, count).
        expect(structuredContent.summary).toBe('Schema inferred from 2 items, 2 fields.');
        expect(structuredContent.nextStep).toContain(HelperTools.DATASET_GET_ITEMS);
        expect(content[1].text).toBe(`${structuredContent.summary}\n${structuredContent.nextStep}`);
    });

    it('returns a plain "is empty" message when the dataset has no items', async () => {
        const result = await (getDatasetSchema as HelperTool).call(
            stubToolCallContext({ datasetId: 'ds-1' }, stubApifyClient({ items: [], total: 0 })),
        );
        const { content, isError } = result as TextToolResult;

        expect(isError).not.toBe(true);
        expect(content[0].text).toBe("Dataset 'ds-1' is empty.");
    });

    it('returns isError with a not-found message when listItems throws 404', async () => {
        const notFound = Object.assign(new Error('Dataset was not found'), { statusCode: 404 });
        const result = await (getDatasetSchema as HelperTool).call(
            stubToolCallContext({ datasetId: 'missing' }, stubApifyClientThrowing(notFound)),
        );
        const { content } = result as TextToolResult;

        expectSoftFailInvalidInput(result);
        expect(content[0].text).toContain("Dataset 'missing' not found");
    });

    it('rethrows non-404 errors from listItems', async () => {
        const serverError = Object.assign(new Error('Internal server error'), { statusCode: 500 });
        await expect(
            (getDatasetSchema as HelperTool).call(
                stubToolCallContext({ datasetId: 'ds-1' }, stubApifyClientThrowing(serverError)),
            ),
        ).rejects.toBe(serverError);
    });

    it('returns isError when schema generation fails (generator returns null)', async () => {
        vi.mocked(generateSchemaFromItems).mockReturnValueOnce(null);

        const result = await (getDatasetSchema as HelperTool).call(
            stubToolCallContext({ datasetId: 'ds-1' }, stubApifyClient({ items: MOCK_ITEMS, total: 2 })),
        );
        const { content, isError, toolTelemetry } = result as TextToolResult & {
            toolTelemetry?: ToolTelemetrySnapshot;
        };

        expect(isError).toBe(true);
        expect(content[0].text).toContain("Failed to generate schema for dataset 'ds-1'");
        expect(toolTelemetry).toEqual(expect.objectContaining({ toolStatus: TOOL_STATUS.FAILED }));
        expect(toolTelemetry?.failureCategory).not.toBe(FAILURE_CATEGORY.INVALID_INPUT);
    });
});
