import dedent from 'dedent';
import { z } from 'zod';

import { HelperTools } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { stripQuoteWrappers } from '../../utils/generic.js';
import { normalizeDatasetFields } from '../core/actor_run_response.js';
import { datasetMetadataOutputSchema } from '../structured_output_schemas.js';
import { buildStorageNotFound, buildStorageResponse } from './storage_helpers.js';

const getDatasetArgs = z.object({
    datasetId: z.string().min(1).describe('Dataset ID or username~dataset-name.'),
});

/**
 * https://docs.apify.com/api/v2/dataset-get
 */
export const getDataset: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HelperTools.DATASET_GET,
    description: dedent`
        Get metadata for a dataset (collection of structured data created by an Actor run).
        The results will include dataset details such as itemCount, schema, fields, and stats.
        Use fields to understand structure for filtering with ${HelperTools.DATASET_GET_ITEMS}.
        Note: itemCount updates may be delayed by up to ~5 seconds.

        USAGE:
        - Use when you need dataset metadata to understand its structure before fetching items.

        USAGE EXAMPLES:
        - user_input: Show info for dataset xyz123
        - user_input: What fields does username~my-dataset have?`,
    inputSchema: z.toJSONSchema(getDatasetArgs) as ToolInputSchema,
    outputSchema: datasetMetadataOutputSchema,
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
        const datasetId = stripQuoteWrappers(parsed.datasetId);
        const dataset = await client.dataset(datasetId).get();
        if (!dataset) {
            return buildStorageNotFound(`Dataset '${datasetId}' not found.`);
        }
        // Apify returns `fields` slash-separated AND with array indices expanded
        // (e.g. `latestComments/0/owner/username`). For a real Instagram-scraper
        // dataset this inflates ~78 schema fields into 528 paths (~85% bloat) and
        // produces slash-notation paths that aren't directly usable as projection
        // hints for `get-dataset-items` (which expects dot-notation). Run the same
        // normalization `buildRunDataset` applies so this tool's `fields` matches
        // the structured `storages.datasets.default.fields` shape.
        const normalized = dataset.fields ? { ...dataset, fields: normalizeDatasetFields(dataset.fields) } : dataset;
        const fieldCount = Array.isArray(normalized.fields) ? normalized.fields.length : undefined;
        const summary = `Dataset '${normalized.name ?? datasetId}' has ${normalized.itemCount ?? 0} items${fieldCount !== undefined ? `, ${fieldCount} fields` : ''}.`;
        const nextStep = `Use ${HelperTools.DATASET_GET_ITEMS} with datasetId=${datasetId} and limit (for example 20) to fetch items.`;
        return buildStorageResponse({
            structuredContent: normalized as unknown as Record<string, unknown>,
            summary,
            nextStep,
        });
    },
} as const);
