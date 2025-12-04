import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

import { ApifyClient } from '../apify-client.js';
import { HelperTools, TOOL_STATUS } from '../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../types.js';
import { ajv } from '../utils/ajv.js';
import { parseCommaSeparatedList } from '../utils/generic.js';
import { buildMCPResponse } from '../utils/mcp.js';
import { generateSchemaFromItems } from '../utils/schema-generation.js';

const getDatasetArgs = z.object({
    datasetId: z.string()
        .min(1)
        .describe('Dataset ID or username~dataset-name.'),
});

const getDatasetItemsArgs = z.object({
    datasetId: z.string()
        .min(1)
        .describe('Dataset ID or username~dataset-name.'),
    clean: z.boolean().optional()
        .describe('If true, returns only non-empty items and skips hidden fields (starting with #). Shortcut for skipHidden=true and skipEmpty=true.'),
    offset: z.number().optional()
        .describe('Number of items to skip at the start. Default is 0.'),
    limit: z.number().optional()
        .describe('Maximum number of items to return. No limit by default.'),
    fields: z.string().optional()
        .describe('Comma-separated list of fields to include in results. '
            + 'Fields in output are sorted as specified. '
            + 'For nested objects, use dot notation (e.g. "metadata.url") after flattening.'),
    omit: z.string().optional()
        .describe('Comma-separated list of fields to exclude from results.'),
    desc: z.boolean().optional()
        .describe('If true, results are returned in reverse order (newest to oldest).'),
    flatten: z.string().optional()
        .describe('Comma-separated list of fields which should transform nested objects into flat structures. '
            + 'For example, with flatten="metadata" the object {"metadata":{"url":"hello"}} becomes {"metadata.url":"hello"}. '
            + 'This is required before accessing nested fields with the fields parameter.'),
});

/**
 * https://docs.apify.com/api/v2/dataset-get
 */
export const getDataset: ToolEntry = {
    type: 'internal',
    name: HelperTools.DATASET_GET,
    description: `Get metadata for a dataset (collection of structured data created by an Actor run).
The results will include dataset details such as itemCount, schema, fields, and stats.
Use fields to understand structure for filtering with ${HelperTools.DATASET_GET_ITEMS}.
Note: itemCount updates may be delayed by up to ~5 seconds.

USAGE:
- Use when you need dataset metadata to understand its structure before fetching items.

USAGE EXAMPLES:
- user_input: Show info for dataset xyz123
- user_input: What fields does username~my-dataset have?`,
    inputSchema: zodToJsonSchema(getDatasetArgs) as ToolInputSchema,
    ajvValidate: ajv.compile(zodToJsonSchema(getDatasetArgs)),
    annotations: {
        title: 'Get dataset',
        readOnlyHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyToken } = toolArgs;
        const parsed = getDatasetArgs.parse(args);
        const client = new ApifyClient({ token: apifyToken });
        const v = await client.dataset(parsed.datasetId).get();
        if (!v) {
            return buildMCPResponse({
                texts: [`Dataset '${parsed.datasetId}' not found.`],
                isError: true,
                toolStatus: TOOL_STATUS.SOFT_FAIL,
            });
        }
        return { content: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(v)}\n\`\`\`` }] };
    },
} as const;

/**
 * https://docs.apify.com/api/v2/dataset-items-get
 */
export const getDatasetItems: ToolEntry = {
    type: 'internal',
    name: HelperTools.DATASET_GET_ITEMS,
    description: `Retrieve dataset items with pagination, sorting, and field selection.
Use clean=true to skip empty items and hidden fields. Include or omit fields using comma-separated lists.
For nested objects, first flatten them (e.g., flatten="metadata"), then reference nested fields via dot notation (e.g., fields="metadata.url").

The results will include items along with pagination info (limit, offset) and total count.

USAGE:
- Use when you need to read data from a dataset (all items or only selected fields).

USAGE EXAMPLES:
- user_input: Get first 100 items from dataset abd123
- user_input: Get only metadata.url and title from dataset username~my-dataset (flatten metadata)`,
    inputSchema: zodToJsonSchema(getDatasetItemsArgs) as ToolInputSchema,
    ajvValidate: ajv.compile(zodToJsonSchema(getDatasetItemsArgs)),
    annotations: {
        title: 'Get dataset items',
        readOnlyHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyToken } = toolArgs;
        const parsed = getDatasetItemsArgs.parse(args);
        const client = new ApifyClient({ token: apifyToken });

        // Convert comma-separated strings to arrays
        const fields = parseCommaSeparatedList(parsed.fields);
        const omit = parseCommaSeparatedList(parsed.omit);
        const flatten = parseCommaSeparatedList(parsed.flatten);

        const v = await client.dataset(parsed.datasetId).listItems({
            clean: parsed.clean,
            offset: parsed.offset,
            limit: parsed.limit,
            fields,
            omit,
            desc: parsed.desc,
            flatten,
        });
        if (!v) {
            return buildMCPResponse({
                texts: [`Dataset '${parsed.datasetId}' not found.`],
                isError: true,
                toolStatus: TOOL_STATUS.SOFT_FAIL,
            });
        }
        return { content: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(v)}\n\`\`\`` }] };
    },
} as const;

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
export const getDatasetSchema: ToolEntry = {
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
    inputSchema: zodToJsonSchema(getDatasetSchemaArgs) as ToolInputSchema,
    ajvValidate: ajv.compile(zodToJsonSchema(getDatasetSchemaArgs)),
    annotations: {
        title: 'Get dataset schema',
        readOnlyHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyToken } = toolArgs;
        const parsed = getDatasetSchemaArgs.parse(args);
        const client = new ApifyClient({ token: apifyToken });

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
} as const;
