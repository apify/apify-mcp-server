import { z } from 'zod';

import { createApifyClientWithSkyfireSupport } from '../../apify_client.js';
import { HelperTools, TOOL_STATUS } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { buildMCPResponse } from '../../utils/mcp.js';

const getDatasetArgs = z.object({
    datasetId: z.string()
        .min(1)
        .describe('Dataset ID or username~dataset-name.'),
});

/**
 * https://docs.apify.com/api/v2/dataset-get
 */
export const getDataset: ToolEntry = Object.freeze({
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
    inputSchema: z.toJSONSchema(getDatasetArgs) as ToolInputSchema,
    /**
     * Allow additional properties for Skyfire mode to pass `skyfire-pay-id`.
     */
    ajvValidate: compileSchema({ ...z.toJSONSchema(getDatasetArgs), additionalProperties: true }),
    requiresSkyfirePayId: true,
    annotations: {
        title: 'Get dataset',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyToken, apifyMcpServer } = toolArgs;
        const parsed = getDatasetArgs.parse(args);

        const client = createApifyClientWithSkyfireSupport(apifyMcpServer, args, apifyToken);
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
} as const);
