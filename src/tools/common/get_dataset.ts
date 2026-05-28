import { z } from 'zod';

import { FAILURE_CATEGORY, HelperTools, TOOL_STATUS } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { buildMCPResponse } from '../../utils/mcp.js';
import { normalizeDatasetFields } from '../core/actor_run_response.js';

const getDatasetArgs = z.object({
    datasetId: z.string().min(1).describe('Dataset ID or username~dataset-name.'),
});

/**
 * https://docs.apify.com/api/v2/dataset-get
 */
export const getDataset: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
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
    ajvValidate: compileSchema(z.toJSONSchema(getDatasetArgs)),
    paymentRequired: true,
    annotations: {
        title: 'Get dataset',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client } = toolArgs;
        const parsed = getDatasetArgs.parse(args);
        const dataset = await client.dataset(parsed.datasetId).get();
        if (!dataset) {
            return buildMCPResponse({
                texts: [`Dataset '${parsed.datasetId}' not found.`],
                isError: true,
                telemetry: { toolStatus: TOOL_STATUS.SOFT_FAIL, failureCategory: FAILURE_CATEGORY.INVALID_INPUT },
            });
        }
        // Apify returns `fields` slash-separated AND with array indices expanded
        // (e.g. `latestComments/0/owner/username`). For a real Instagram-scraper
        // dataset this inflates ~78 schema fields into 528 paths (~85% bloat) and
        // produces slash-notation paths that aren't directly usable as projection
        // hints for `get-dataset-items` (which expects dot-notation). Run the same
        // normalization `buildRunDataset` applies so this tool's `fields` matches
        // the structured `storages.datasets.default.fields` shape.
        const normalized = dataset.fields ? { ...dataset, fields: normalizeDatasetFields(dataset.fields) } : dataset;
        return { content: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(normalized)}\n\`\`\`` }] };
    },
} as const);
