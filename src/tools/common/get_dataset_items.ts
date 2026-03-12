import { z } from 'zod';

import { createApifyClientWithSkyfireSupport } from '../../apify_client.js';
import { HelperTools, TOOL_STATUS } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { parseCommaSeparatedList } from '../../utils/generic.js';
import { buildMCPResponse } from '../../utils/mcp.js';
import { datasetItemsOutputSchema } from '../structured_output_schemas.js';

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
 * https://docs.apify.com/api/v2/dataset-items-get
 */
export const getDatasetItems: ToolEntry = Object.freeze({
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
    inputSchema: z.toJSONSchema(getDatasetItemsArgs) as ToolInputSchema,
    outputSchema: datasetItemsOutputSchema,
    /**
     * Allow additional properties for Skyfire mode to pass `skyfire-pay-id`.
     */
    ajvValidate: compileSchema({ ...z.toJSONSchema(getDatasetItemsArgs), additionalProperties: true }),
    requiresSkyfirePayId: true,
    annotations: {
        title: 'Get dataset items',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyToken, apifyMcpServer } = toolArgs;
        const parsed = getDatasetItemsArgs.parse(args);

        const client = createApifyClientWithSkyfireSupport(apifyMcpServer, args, apifyToken);

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

        const structuredContent = {
            datasetId: parsed.datasetId,
            items: v.items,
            itemCount: v.items.length,
            totalItemCount: v.count,
            offset: parsed.offset ?? 0,
            limit: parsed.limit,
        };

        return { content: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(v)}\n\`\`\`` }], structuredContent };
    },
} as const);
