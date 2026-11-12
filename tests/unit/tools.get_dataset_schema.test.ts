import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FAILURE_CATEGORY, HELPER_TOOLS, MAX_INLINE_BYTES, TOOL_STATUS } from '../../src/const.js';
import { DATASET_SCHEMA_MAX_LIMIT, getDatasetSchema } from '../../src/tools/storage/get_dataset_schema.js';
import { datasetSchemaOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import type * as SchemaGenModule from '../../src/utils/schema_generation.js';
import { generateSchemaFromItems } from '../../src/utils/schema_generation.js';
import { type DatasetItemsServer, startDatasetItemsServer } from './helpers/dataset_items_server.js';
import {
    apiErrorResponse,
    datasetItemsResponse,
    expectSchemaConformingStructuredContent,
    expectSoftFailInvalidInput,
    mockDatasetItemsClient,
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

function stubApifyClient(page: { items: unknown[]; total: number }): InternalToolArgs['apifyClient'] {
    return mockDatasetItemsClient(async () => datasetItemsResponse(page.items, page.total));
}

describe('get-dataset-schema', () => {
    it('has the expected tool name', () => {
        expect(getDatasetSchema.name).toBe(HELPER_TOOLS.DATASET_SCHEMA_GET);
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
        expect(structuredContent.nextStep).toContain(HELPER_TOOLS.DATASET_GET_ITEMS);
        expect(content[1].text).toBe(`${structuredContent.summary}\n${structuredContent.nextStep}`);
    });

    it('requests the default sample (limit=5, clean=true) in one request capped at the inline limit', async () => {
        const requestSpy = vi.fn().mockResolvedValue(datasetItemsResponse(MOCK_ITEMS, 2));

        await (getDatasetSchema as HelperTool).call(
            stubToolCallContext({ datasetId: 'ds-1' }, mockDatasetItemsClient(requestSpy)),
        );

        expect(requestSpy).toHaveBeenCalledOnce();
        expect(requestSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                params: { clean: true, limit: 5 },
                maxContentLength: MAX_INLINE_BYTES,
            }),
        );
    });

    it('accepts an integer limit from 1 to the maximum sample size', () => {
        const tool = getDatasetSchema as HelperTool;
        for (const limit of [0, 1.5, DATASET_SCHEMA_MAX_LIMIT + 1]) {
            expect(tool.ajvValidate({ datasetId: 'ds-1', limit })).toBe(false);
        }
        for (const limit of [1, DATASET_SCHEMA_MAX_LIMIT]) {
            expect(tool.ajvValidate({ datasetId: 'ds-1', limit })).toBe(true);
        }
    });

    it('returns a schema-conforming structured response when the dataset has no items', async () => {
        const result = await (getDatasetSchema as HelperTool).call(
            stubToolCallContext({ datasetId: 'ds-1', clean: false }, stubApifyClient({ items: [], total: 0 })),
        );
        const { content, isError, structuredContent } = result as TextToolResult & {
            structuredContent: Record<string, unknown>;
        };

        expect(isError).not.toBe(true);
        expect(structuredContent.datasetId).toBe('ds-1');
        expect(structuredContent.schema).toEqual({});
        expect(structuredContent.summary).toBe("Dataset 'ds-1' is empty; no schema to infer.");
        expect(structuredContent.nextStep).toBe(
            `Use ${HELPER_TOOLS.DATASET_GET} with datasetId=ds-1 to check itemCount and stats.`,
        );
        expect(content[1].text).toBe(`${structuredContent.summary}\n${structuredContent.nextStep}`);
        // The required `schema` is still present (empty object) and the emit conforms to the schema.
        expectSchemaConformingStructuredContent(result, datasetSchemaOutputSchema);
    });

    // clean=true skips empty items and #-prefixed fields, so a dataset of hidden-field items comes
    // back as items=[] and must not be reported as empty.
    it('suggests clean=false instead of reporting empty when clean filtering returned no items', async () => {
        const result = await (getDatasetSchema as HelperTool).call(
            stubToolCallContext({ datasetId: 'ds-1' }, stubApifyClient({ items: [], total: 3 })),
        );
        const { isError, structuredContent } = result as TextToolResult & {
            structuredContent: Record<string, unknown>;
        };

        expect(isError).not.toBe(true);
        expect(structuredContent.schema).toEqual({});
        expect(structuredContent.summary).not.toContain('is empty');
        // States what clean=false does rather than telling the agent to call again (TOOL_GUIDELINES.md).
        expect(structuredContent.nextStep).toBe(
            `clean=false includes those items. Use ${HELPER_TOOLS.DATASET_GET} with datasetId=ds-1 to check itemCount and stats.`,
        );
        expectSchemaConformingStructuredContent(result, datasetSchemaOutputSchema);
    });

    it('reports empty without the clean=false hint when the dataset has no items under clean=true', async () => {
        const result = await (getDatasetSchema as HelperTool).call(
            stubToolCallContext({ datasetId: 'ds-1' }, stubApifyClient({ items: [], total: 0 })),
        );
        const { structuredContent } = result as TextToolResult & { structuredContent: Record<string, unknown> };

        expect(structuredContent.summary).toContain('is empty');
        expect(structuredContent.nextStep).not.toContain('clean=false');
    });

    it('returns isError with a not-found message when the API responds 404', async () => {
        const client = mockDatasetItemsClient(async () =>
            apiErrorResponse(404, 'record-not-found', 'Dataset was not found'),
        );
        const result = await (getDatasetSchema as HelperTool).call(
            stubToolCallContext({ datasetId: 'missing' }, client),
        );
        const { content, structuredContent } = result as TextToolResult & { structuredContent?: unknown };

        expectSoftFailInvalidInput(result);
        expect(structuredContent).toBeUndefined();
        expect(content[0].text).toContain("Dataset 'missing' not found");
    });

    it('throws a non-404 API error response', async () => {
        const client = mockDatasetItemsClient(async () =>
            apiErrorResponse(500, 'internal-error', 'Internal server error'),
        );
        await expect(
            (getDatasetSchema as HelperTool).call(stubToolCallContext({ datasetId: 'ds-1' }, client)),
        ).rejects.toMatchObject({ statusCode: 500, message: 'Internal server error' });
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

// Regression: #1296 — nextStep named a sibling tool the session was not served.
describe('get-dataset-schema nextStep gating', () => {
    it.each([
        {
            name: 'nonempty output',
            args: { datasetId: 'ds-1' },
            response: { items: MOCK_ITEMS, total: 2 },
            sibling: HELPER_TOOLS.DATASET_GET_ITEMS,
            fallback: 'No follow-up step.',
        },
        {
            name: 'empty output',
            args: { datasetId: 'ds-1', clean: false },
            response: { items: [], total: 0 },
            sibling: HELPER_TOOLS.DATASET_GET,
            fallback: 'No follow-up step.',
        },
        {
            name: 'clean-filtered output',
            args: { datasetId: 'ds-1' },
            response: { items: [], total: 3 },
            sibling: HELPER_TOOLS.DATASET_GET,
            fallback: 'clean=false includes those items.',
        },
    ])('falls back on $name when $sibling is not loaded', async ({ args, response, sibling, fallback }) => {
        const result = (await (getDatasetSchema as HelperTool).call(
            stubToolCallContext(args, stubApifyClient(response), {
                loadedToolNames: [HELPER_TOOLS.DATASET_SCHEMA_GET],
            }),
        )) as TextToolResult & { structuredContent: Record<string, unknown> };

        expect(result.structuredContent.nextStep).toBe(fallback);
        expect(JSON.stringify([result.content, result.structuredContent])).not.toContain(sibling);
        expectSchemaConformingStructuredContent(result, datasetSchemaOutputSchema);
    });
});

describe('get-dataset-schema over the response size limit', () => {
    let server: DatasetItemsServer;
    beforeAll(async () => {
        server = await startDatasetItemsServer();
        const pages = Array.from({ length: 30 }, (_, n) => ({
            url: `https://example.com/${n}`,
            text: 'x'.repeat(20_000),
        }));
        server.serve('~crawl', [{ items: pages }]);
        server.serve('~big', [{ items: [{ text: 'x'.repeat(MAX_INLINE_BYTES) }, { n: 2 }] }]);
    });
    afterAll(async () => server.close());

    it('infers the schema from the whole items that fit and says the sample stops there', async () => {
        const result = await (getDatasetSchema as HelperTool).call(
            stubToolCallContext({ datasetId: 'crawl', limit: 20 }, server.client),
        );
        const { structuredContent } = result as TextToolResult & { structuredContent: Record<string, unknown> };

        expectSchemaConformingStructuredContent(result, datasetSchemaOutputSchema);
        expect(structuredContent.schema).toMatchObject({ items: { properties: { url: {}, text: {} } } });
        const [, used] = /^Schema inferred from (\d+) items/.exec(structuredContent.summary as string) ?? [];
        expect(Number(used)).toBeGreaterThan(0);
        expect(Number(used)).toBeLessThan(20);
        expect(structuredContent.summary).toContain(`${MAX_INLINE_BYTES}`);
    });

    it.each([
        { name: 'names get-dataset for the field list', loaded: Object.values(HELPER_TOOLS), named: true },
        { name: 'names no sibling it was not served', loaded: [HELPER_TOOLS.DATASET_SCHEMA_GET], named: false },
    ])('when the first item alone is too large, returns an error that $name', async ({ loaded, named }) => {
        const result = await (getDatasetSchema as HelperTool).call(
            stubToolCallContext({ datasetId: 'big' }, server.client, { loadedToolNames: loaded }),
        );
        const { text } = (result as TextToolResult).content[0];

        expectSoftFailInvalidInput(result);
        expect(text).toContain(`${MAX_INLINE_BYTES} bytes`);
        expect(text.includes(`${HELPER_TOOLS.DATASET_GET} `)).toBe(named);
    });
});

describe('get-dataset-schema with a bare dataset name', () => {
    it("reads the name as one of the caller's own datasets", async () => {
        const requestSpy = vi.fn().mockResolvedValue(datasetItemsResponse(MOCK_ITEMS, 2));

        await (getDatasetSchema as HelperTool).call(
            stubToolCallContext({ datasetId: 'eval-ai-items' }, mockDatasetItemsClient(requestSpy)),
        );

        expect(requestSpy).toHaveBeenCalledWith(
            expect.objectContaining({ url: 'https://api.apify.com/v2/datasets/~eval-ai-items/items' }),
        );
    });
});
