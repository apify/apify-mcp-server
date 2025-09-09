import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

import { ApifyClient } from '../apify-client.js';
import { HelperTools } from '../const.js';
import type { InternalTool, ToolEntry } from '../types.js';
import { ajv } from '../utils/ajv.js';
import { parseCommaSeparatedList } from '../utils/generic.js';
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
    tool: {
        name: HelperTools.DATASET_GET,
        actorFullName: HelperTools.DATASET_GET,
        description: 'Dataset is a collection of structured data created by an Actor run. '
            + 'Returns information about dataset object with metadata (itemCount, schema, fields, stats). '
            + `Fields describe the structure of the dataset and can be used to filter the data with the ${HelperTools.DATASET_GET_ITEMS} tool. `
            + 'Note: itemCount updates may have 5s delay.'
            + 'The dataset can be accessed with the dataset URL: GET: https://api.apify.com/v2/datasets/:datasetId',
        inputSchema: zodToJsonSchema(getDatasetArgs),
        ajvValidate: ajv.compile(zodToJsonSchema(getDatasetArgs)),
        call: async (toolArgs) => {
            const { args, apifyToken } = toolArgs;
            const parsed = getDatasetArgs.parse(args);
            const client = new ApifyClient({ token: apifyToken });
            const v = await client.dataset(parsed.datasetId).get();
            if (!v) {
                return { content: [{ type: 'text', text: `Dataset '${parsed.datasetId}' not found.` }] };
            }
            return { content: [{ type: 'text', text: JSON.stringify(v) }] };
        },
    } as InternalTool,
};

/**
 * https://docs.apify.com/api/v2/dataset-items-get
 */
export const getDatasetItems: ToolEntry = {
    type: 'internal',
    tool: {
        name: HelperTools.DATASET_GET_ITEMS,
        actorFullName: HelperTools.DATASET_GET_ITEMS,
        description: 'Returns dataset items with pagination support. '
            + 'Items can be sorted (newest to oldest) and filtered (clean mode skips empty items and hidden fields). '
            + 'Supports field selection - include specific fields or exclude unwanted ones using comma-separated lists. '
            + 'For nested objects, you must first flatten them using the flatten parameter before accessing their fields. '
            + 'Example: To get URLs from items like [{"metadata":{"url":"example.com"}}], '
            + 'use flatten="metadata" and then fields="metadata.url". '
            + 'The flattening transforms nested objects into dot-notation format '
            + '(e.g. {"metadata":{"url":"x"}} becomes {"metadata.url":"x"}). '
            + 'Retrieve only the fields you need, reducing the response size and improving performance. '
            + 'The response includes total count, offset, limit, and items array.',
        inputSchema: zodToJsonSchema(getDatasetItemsArgs),
        ajvValidate: ajv.compile(zodToJsonSchema(getDatasetItemsArgs)),
        call: async (toolArgs) => {
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
                return { content: [{ type: 'text', text: `Dataset '${parsed.datasetId}' not found.` }] };
            }
            return { content: [{ type: 'text', text: JSON.stringify(v) }] };
        },
    } as InternalTool,
};

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
    tool: {
        name: HelperTools.DATASET_SCHEMA_GET,
        actorFullName: HelperTools.DATASET_SCHEMA_GET,
        description: 'Generates a JSON schema from dataset items. '
            + 'The schema describes the structure of the data in the dataset, which can be used for validation, documentation, or data processing.'
            + 'Since the dataset can be large it is convenient to understand the structure of the dataset before getting dataset items.',
        inputSchema: zodToJsonSchema(getDatasetSchemaArgs),
        ajvValidate: ajv.compile(zodToJsonSchema(getDatasetSchemaArgs)),
        call: async (toolArgs) => {
            const { args, apifyToken } = toolArgs;
            const parsed = getDatasetSchemaArgs.parse(args);
            const client = new ApifyClient({ token: apifyToken });

            // Get dataset items
            const datasetResponse = await client.dataset(parsed.datasetId).listItems({
                clean: parsed.clean,
                limit: parsed.limit,
            });

            if (!datasetResponse) {
                return { content: [{ type: 'text', text: `Dataset '${parsed.datasetId}' not found.` }] };
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
                return { content: [{ type: 'text', text: `Failed to generate schema for dataset '${parsed.datasetId}'.` }] };
            }

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify(schema),
                }],
            };
        },
    } as InternalTool,
};
