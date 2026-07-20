import dedent from 'dedent';
import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { stripQuoteWrappers } from '../../utils/generic.js';
import { respondServerError, respondUserError } from '../../utils/mcp.js';
import { generateSchemaFromItems } from '../../utils/schema_generation.js';
import { datasetSchemaOutputSchema } from '../structured_output_schemas.js';
import { buildStorageResponse, catchNotFound } from './storage_helpers.js';

const getDatasetSchemaArgs = z.object({
    datasetId: z.string().min(1).describe('Dataset ID or username~dataset-name.'),
    limit: z.number().describe('Maximum number of items to use for schema generation. Default is 5.').default(5),
    clean: z
        .boolean()
        .describe('If true, uses only non-empty items and skips hidden fields (starting with #). Default is true.')
        .default(true),
});

/**
 * Generates a JSON schema from dataset items
 */
export const getDatasetSchema: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.DATASET_SCHEMA_GET,
    title: 'Get dataset schema',
    description: dedent`
        Generate a JSON schema inferred from a sample of dataset items — field names and types.
        Not the full field list, item counts, or stats — use ${HELPER_TOOLS.DATASET_GET} for those.
        The schema can be used for validation, documentation, or processing.

        Do not use for metadata, stats, or fetching rows — use ${HELPER_TOOLS.DATASET_GET} or ${HELPER_TOOLS.DATASET_GET_ITEMS}.

        USAGE:
        - Use when the user asks for a JSON schema or to infer structure/shape from a sample.

        USAGE EXAMPLES:
        - user_input: Generate schema for dataset 34das2 using 10 items
        - user_input: Show schema of username~my-dataset (clean items only)`,
    inputSchema: z.toJSONSchema(getDatasetSchemaArgs) as ToolInputSchema,
    outputSchema: datasetSchemaOutputSchema,
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

        const datasetResponse = await catchNotFound(
            client.dataset(datasetId).listItems({ clean: parsed.clean, limit: parsed.limit }),
        );

        if (!datasetResponse) {
            return respondUserError(`Dataset '${datasetId}' not found.`);
        }

        const datasetItems = datasetResponse.items;

        if (datasetItems.length === 0) {
            // Empty dataset: no items to infer from, but still emit a schema-conforming
            // response (empty schema = "any") rather than bare text.
            const summary = `Dataset '${datasetId}' is empty; no schema to infer.`;
            const nextStep = `Use ${HELPER_TOOLS.DATASET_GET} with datasetId=${datasetId} to check itemCount and stats.`;
            return buildStorageResponse({ structuredContent: { datasetId, schema: {} }, summary, nextStep });
        }

        // Generate schema using the shared utility
        const schema = generateSchemaFromItems(datasetItems, {
            limit: parsed.limit,
            clean: parsed.clean,
        });

        if (!schema) {
            // A schema-generation failure is a server/processing error, not a user error.
            return respondServerError(`Failed to generate schema for dataset '${datasetId}'.`);
        }

        const fieldCount = Object.keys(schema.items.properties ?? {}).length;
        const summary = `Schema inferred from ${datasetItems.length} ${datasetItems.length === 1 ? 'item' : 'items'}, ${fieldCount} ${fieldCount === 1 ? 'field' : 'fields'}.`;
        const nextStep = `Use ${HELPER_TOOLS.DATASET_GET_ITEMS} with datasetId=${datasetId} and fields="..." to project specific fields.`;
        return buildStorageResponse({ structuredContent: { datasetId, schema }, summary, nextStep });
    },
} as const);
