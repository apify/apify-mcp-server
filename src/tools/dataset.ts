import { Ajv } from 'ajv';
import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

import { ApifyClient } from '../apify-client.js';
import { HelperTools } from '../const.js';
import type { InternalTool, ToolWrap } from '../types.js';

const ajv = new Ajv({ coerceTypes: 'array', strict: false });

const getDatasetArgs = z.object({
    datasetId: z.string().describe('Dataset ID or username~dataset-name.'),
});

const getDatasetItemsArgs = z.object({
    datasetId: z.string().describe('Dataset ID or username~dataset-name.'),
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
export const getDataset: ToolWrap = {
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
            return { content: [{ type: 'text', text: JSON.stringify(v) }] };
        },
    } as InternalTool,
};

/**
 * https://docs.apify.com/api/v2/dataset-items-get
 */
export const getDatasetItems: ToolWrap = {
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
            const fields = parsed.fields?.split(',').map((f) => f.trim());
            const omit = parsed.omit?.split(',').map((f) => f.trim());
            const flatten = parsed.flatten?.split(',').map((f) => f.trim());

            const v = await client.dataset(parsed.datasetId).listItems({
                clean: parsed.clean,
                offset: parsed.offset,
                limit: parsed.limit,
                fields,
                omit,
                desc: parsed.desc,
                flatten,
            });
            return { content: [{ type: 'text', text: JSON.stringify(v) }] };
        },
    } as InternalTool,
};
