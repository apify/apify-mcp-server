import dedent from 'dedent';
import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { buildConsoleDatasetUrl, getConsoleLinkContext } from '../../utils/console_link.js';
import { stripQuoteWrappers } from '../../utils/generic.js';
import { respondUserError } from '../../utils/mcp.js';
import { datasetSizeNextStepHint, normalizeDatasetFields } from '../actors/actor_run_response.js';
import { datasetMetadataOutputSchema } from '../structured_output_schemas.js';
import { DEFAULT_DATASET_ITEMS_LIMIT } from './get_dataset_items.js';
import { buildStorageResponse } from './storage_helpers.js';

const getDatasetArgs = z.object({
    datasetId: z.string().min(1).describe('Dataset ID or username~dataset-name.'),
});

/**
 * https://docs.apify.com/api/v2/dataset-get
 */
export const getDataset: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.DATASET_GET,
    title: 'Get dataset',
    description: dedent`
        Get metadata for a dataset — a collection of structured data produced by an Actor run.
        Returns the field list and item counts, not the row data — use ${HELPER_TOOLS.DATASET_GET_ITEMS} for the data, ${HELPER_TOOLS.DATASET_SCHEMA_GET} for inferred field types.
        Do not use when the user asks to retrieve, show, or get results/data/rows — use ${HELPER_TOOLS.DATASET_GET_ITEMS}.
        stats.inflatedBytes (when present) is the approximate uncompressed byte size — use it with itemCount to pick a safe limit and fields before fetching.
        Note: itemCount updates may be delayed by up to ~5 seconds.

        USAGE:
        - Use when you need dataset metadata: item count, stats, or the field list.
        - Call this tool alone — do not also call ${HELPER_TOOLS.DATASET_SCHEMA_GET}.

        USAGE EXAMPLES:
        - user_input: Show info for dataset xyz123
        - user_input: How many items does dataset xyz123 have?`,
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
        const { args, apifyClient: client, apifyToken } = toolArgs;
        const parsed = getDatasetArgs.parse(args);
        const datasetId = stripQuoteWrappers(parsed.datasetId);
        const dataset = await client.dataset(datasetId).get();
        if (!dataset) {
            return respondUserError(`Dataset '${datasetId}' not found.`);
        }
        const linkContext = await getConsoleLinkContext(apifyToken, client);
        // The API also returns a raw `schema` (untyped in apify-client). It is 93–95% of the
        // response bytes on top store Actors and declares fields that may be absent from the
        // data, so drop it — get-dataset-schema infers a compact schema from real items (#882).
        const { schema, ...metadata } = dataset as typeof dataset & { schema?: unknown };
        // Apify returns `fields` slash-separated AND with array indices expanded
        // (e.g. `latestComments/0/owner/username`). For a real Instagram-scraper
        // dataset this inflates ~78 schema fields into 528 paths (~85% bloat) and
        // produces slash-notation paths that aren't directly usable as projection
        // hints for `get-dataset-items` (which expects dot-notation). Run the same
        // normalization `buildRunDataset` applies so this tool's `fields` matches
        // the structured `storages.datasets.default.fields` shape.
        const normalized = metadata.fields
            ? { ...metadata, fields: normalizeDatasetFields(metadata.fields) }
            : metadata;
        const fieldCount = Array.isArray(normalized.fields) ? normalized.fields.length : undefined;
        // `inflatedBytes` is undeclared on the apify-client `DatasetStats` type and absent from the GET
        // response today (only the dataset-list endpoint returns it), so read it defensively.
        const inflatedBytes = (dataset.stats as { inflatedBytes?: number } | undefined)?.inflatedBytes;
        const summary = `Dataset '${normalized.name ?? datasetId}' has ${normalized.itemCount ?? 0} items${fieldCount !== undefined ? `, ${fieldCount} fields` : ''}.`;
        const nextStep = `Use ${HELPER_TOOLS.DATASET_GET_ITEMS} with datasetId=${datasetId} and limit (for example ${DEFAULT_DATASET_ITEMS_LIMIT}) to fetch items.${datasetSizeNextStepHint(inflatedBytes)}`;
        return buildStorageResponse({
            structuredContent: normalized as unknown as Record<string, unknown>,
            summary,
            nextStep,
            apifyConsoleUrl: buildConsoleDatasetUrl(linkContext, dataset.id),
        });
    },
} as const);
