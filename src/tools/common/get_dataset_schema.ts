import { z } from 'zod';

import { createApifyClientWithSkyfireSupport } from '../../apify_client.js';
import { HelperTools, TOOL_STATUS } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { buildMCPResponse } from '../../utils/mcp.js';
import { generateSchemaFromItems } from '../../utils/schema_generation.js';

const getDatasetSchemaArgs = z.object({
    datasetId: z.string()
        .min(1)
        .describe('Dataset ID or username~dataset-name.'),
    limit: z.number().optional()
        .describe('Maximum number of items to use for schema generation. Default is 5.')
        .default(5),
    clean: z.boolean().optional()
        .describe('If true, uses only non-empty items and skips hidden fields (starting with #). Default is true.')
        .default(true),
    arrayMode: z.enum(['first', 'all']).optional()
        .describe('Strategy for handling arrays. "first" uses first item as template, "all" merges all items. Default is "all".')
        .default('all'),
});

/**
 * Generates a JSON schema from dataset items
 */
export const getDatasetSchema: ToolEntry = Object.freeze({
    type: 'internal',
    name: HelperTools.DATASET_SCHEMA_GET,
    description: `Generate a JSON schema from a sample of dataset items.
The schema describes the structure of the data and can be used for validation, documentation, or processing.
Use this to understand the dataset before fetching many items.

USAGE:
- Use when you need to infer the structure of dataset items for downstream processing or validation.

USAGE EXAMPLES:
- user_input: Generate schema for dataset 34das2 using 10 items
- user_input: Show schema of username~my-dataset (clean items only)`,
    inputSchema: z.toJSONSchema(getDatasetSchemaArgs) as ToolInputSchema,
    /**
     * Allow additional properties for Skyfire mode to pass `skyfire-pay-id`.
     */
    ajvValidate: compileSchema({ ...z.toJSONSchema(getDatasetSchemaArgs), additionalProperties: true }),
    requiresSkyfirePayId: true,
    annotations: {
        title: 'Get dataset schema',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyToken, apifyMcpServer } = toolArgs;
        const parsed = getDatasetSchemaArgs.parse(args);

        const client = createApifyClientWithSkyfireSupport(apifyMcpServer, args, apifyToken);

        // Get dataset items
        const datasetResponse = await client.dataset(parsed.datasetId).listItems({
            clean: parsed.clean,
            limit: parsed.limit,
        });

        if (!datasetResponse) {
            return buildMCPResponse({
                texts: [`Dataset '${parsed.datasetId}' not found.`],
                isError: true,
                toolStatus: TOOL_STATUS.SOFT_FAIL,
            });
        }

        const datasetItems = datasetResponse.items;

        if (datasetItems.length === 0) {
            return { content: [{ type: 'text', text: `Dataset '${parsed.datasetId}' is empty.` }] };
        }

        // Generate schema using the shared utility
        const schema = generateSchemaFromItems(datasetItems, {
            limit: parsed.limit,
            clean: parsed.clean,
            arrayMode: parsed.arrayMode,
        });

        if (!schema) {
            // Schema generation failure is typically a server/processing error, not a user error
            return buildMCPResponse({
                texts: [`Failed to generate schema for dataset '${parsed.datasetId}'.`],
                isError: true,
                toolStatus: TOOL_STATUS.FAILED,
            });
        }

        return {
            content: [{
                type: 'text',
                text: `\`\`\`json\n${JSON.stringify(schema)}\n\`\`\``,
            }],
        };
    },
} as const);
