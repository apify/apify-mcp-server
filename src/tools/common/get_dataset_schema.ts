import dedent from 'dedent';
import { z } from 'zod';

import { HelperTools, HTTP_NOT_FOUND, TOOL_STATUS } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { stripQuoteWrappers } from '../../utils/generic.js';
import { getHttpStatusCode } from '../../utils/logging.js';
import { buildMCPResponse, wrapJsonText } from '../../utils/mcp.js';
import { generateSchemaFromItems } from '../../utils/schema_generation.js';
import { buildStorageNotFound } from './storage_helpers.js';

const getDatasetSchemaArgs = z.object({
    datasetId: z.string().min(1).describe('Dataset ID or username~dataset-name.'),
    limit: z
        .number()
        .optional()
        .describe('Maximum number of items to use for schema generation. Default is 5.')
        .default(5),
    clean: z
        .boolean()
        .optional()
        .describe('If true, uses only non-empty items and skips hidden fields (starting with #). Default is true.')
        .default(true),
});

/**
 * Generates a JSON schema from dataset items
 */
export const getDatasetSchema: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HelperTools.DATASET_SCHEMA_GET,
    description: dedent`
        Generate a JSON schema from a sample of dataset items.
        The schema describes the structure of the data and can be used for validation, documentation, or processing.
        Use this to understand the dataset before fetching many items.

        USAGE:
        - Use when you need to infer the structure of dataset items for downstream processing or validation.

        USAGE EXAMPLES:
        - user_input: Generate schema for dataset 34das2 using 10 items
        - user_input: Show schema of username~my-dataset (clean items only)`,
    inputSchema: z.toJSONSchema(getDatasetSchemaArgs) as ToolInputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(getDatasetSchemaArgs)),
    paymentRequired: true,
    annotations: {
        title: 'Get dataset schema',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client } = toolArgs;
        const parsed = getDatasetSchemaArgs.parse(args);
        const datasetId = stripQuoteWrappers(parsed.datasetId);

        // `listItems()` throws ApifyApiError on a missing dataset (the SDK only soft-catches
        // 404 on `.get()` / `.getStatistics()`), so translate 404 into a soft-fail.
        const datasetResponse = await client
            .dataset(datasetId)
            .listItems({ clean: parsed.clean, limit: parsed.limit })
            .catch((err: unknown) => {
                if (getHttpStatusCode(err) === HTTP_NOT_FOUND) {
                    return null;
                }
                throw err;
            });

        if (!datasetResponse) {
            return buildStorageNotFound(`Dataset '${datasetId}' not found.`);
        }

        const datasetItems = datasetResponse.items;

        if (datasetItems.length === 0) {
            return { content: [{ type: 'text', text: `Dataset '${datasetId}' is empty.` }] };
        }

        // Generate schema using the shared utility
        const schema = generateSchemaFromItems(datasetItems, {
            limit: parsed.limit,
            clean: parsed.clean,
        });

        if (!schema) {
            // Schema generation failure is typically a server/processing error, not a user error
            return buildMCPResponse({
                texts: [`Failed to generate schema for dataset '${datasetId}'.`],
                isError: true,
                telemetry: { toolStatus: TOOL_STATUS.FAILED },
            });
        }

        return { content: [{ type: 'text', text: wrapJsonText(schema) }] };
    },
} as const);
