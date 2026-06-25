import dedent from 'dedent';
import { z } from 'zod';

import { HelperTools, HTTP_NOT_FOUND } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { buildConsoleDatasetUrl, getConsoleLinkContext } from '../../utils/console_link.js';
import { parseCommaSeparatedList, stripQuoteWrappers } from '../../utils/generic.js';
import { getHttpStatusCode } from '../../utils/logging.js';
import { datasetItemsOutputSchema } from '../structured_output_schemas.js';
import { buildDatasetItemsSummaryNextStep, buildStorageNotFound, buildStorageResponse } from './storage_helpers.js';

const DEFAULT_DATASET_ITEMS_LIMIT = 20;

/** Top-level dot prefixes of `fields`. Apify's `flatten` recurses, so the first segment suffices. */
export function extractDotPrefixes(fields: string[]): string[] {
    const prefixes = new Set<string>();
    for (const field of fields) {
        const dotIndex = field.indexOf('.');
        if (dotIndex > 0) {
            prefixes.add(field.slice(0, dotIndex));
        }
    }
    return [...prefixes];
}

const getDatasetItemsArgs = z.object({
    datasetId: z.string().min(1).describe('Dataset ID or username~dataset-name.'),
    clean: z
        .boolean()
        .optional()
        .describe(
            'If true, returns only non-empty items and skips hidden fields (starting with #). Shortcut for skipHidden=true and skipEmpty=true.',
        ),
    offset: z.number().optional().describe('Number of items to skip at the start. Default is 0.'),
    limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(`Maximum number of items to return. Defaults to ${DEFAULT_DATASET_ITEMS_LIMIT}.`),
    fields: z
        .string()
        .optional()
        .describe(
            'Comma-separated list of fields to include in results. ' +
                'Fields in output are sorted as specified. ' +
                'Use dot notation for nested objects (e.g. "metadata.url"); the server auto-flattens parent prefixes.',
        ),
    omit: z.string().optional().describe('Comma-separated list of fields to exclude from results.'),
    desc: z.boolean().optional().describe('If true, results are returned in reverse order (newest to oldest).'),
    flatten: z
        .string()
        .optional()
        .describe(
            'Comma-separated list of fields to flatten (e.g. flatten="metadata" turns {"metadata":{"url":"x"}} into {"metadata.url":"x"}). ' +
                'Normally derived automatically from dot-notation in `fields`; specify only as a diagnostic override.',
        ),
});

/**
 * https://docs.apify.com/api/v2/dataset-items-get
 */
export const getDatasetItems: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HelperTools.DATASET_GET_ITEMS,
    description: dedent`
        Retrieve dataset items with pagination, sorting, and field selection.
        Dataset items are often large — filter aggressively to avoid wasting tokens:
        - Pass \`fields\` to return only the columns you need (the biggest token saver). Use ${HelperTools.DATASET_SCHEMA_GET} or ${HelperTools.DATASET_GET} first if you don't know the field names.
        - Use \`limit\` to cap how many items you fetch; raise it only when the user actually needs more.
        - Set \`clean=true\` to drop empty items and hidden (#) fields, and \`omit\` to exclude bulky fields you don't need.
        For nested fields use dot notation (e.g., fields="metadata.url") — the server auto-flattens parent prefixes.
        Defaults limit to ${DEFAULT_DATASET_ITEMS_LIMIT}.

        The results will include items along with pagination info (limit, offset) and total count.

        USAGE:
        - Use when you need to read data from a dataset. When you only need specific fields, always pass \`fields\` instead of fetching whole items.

        USAGE EXAMPLES:
        - user_input: Get only url and title from dataset username~my-dataset → fields="url,title"
        - user_input: Get first 20 items from dataset abd123`,
    inputSchema: z.toJSONSchema(getDatasetItemsArgs) as ToolInputSchema,
    outputSchema: datasetItemsOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(getDatasetItemsArgs)),
    paymentRequired: true,
    annotations: {
        title: 'Get dataset items',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client, apifyToken } = toolArgs;
        const parsed = getDatasetItemsArgs.parse(args);

        const fields = parseCommaSeparatedList(parsed.fields);
        const omit = parseCommaSeparatedList(parsed.omit);
        const flatten =
            parsed.flatten !== undefined ? parseCommaSeparatedList(parsed.flatten) : extractDotPrefixes(fields);

        const effectiveLimit = parsed.limit ?? DEFAULT_DATASET_ITEMS_LIMIT;
        const datasetId = stripQuoteWrappers(parsed.datasetId);
        // `dataset(id).listItems()` throws ApifyApiError on a missing dataset
        // instead of returning undefined (only `.get()` and `.getStatistics()`
        // soft-catch 404 in the SDK), so translate 404 into a soft-fail.
        const v = await client
            .dataset(datasetId)
            .listItems({
                clean: parsed.clean,
                offset: parsed.offset,
                limit: effectiveLimit,
                fields,
                omit,
                desc: parsed.desc,
                flatten,
            })
            .catch((err: unknown) => {
                if (getHttpStatusCode(err) === HTTP_NOT_FOUND) {
                    return null;
                }
                throw err;
            });
        if (!v) {
            return buildStorageNotFound(`Dataset '${datasetId}' not found.`);
        }

        const offset = parsed.offset ?? 0;
        const apifyConsoleUrl = buildConsoleDatasetUrl(await getConsoleLinkContext(apifyToken, client), datasetId);
        const structuredContent = {
            datasetId,
            apifyConsoleUrl,
            items: v.items,
            itemCount: v.items.length,
            totalItemCount: v.total,
            offset,
            limit: effectiveLimit,
        };

        const { summary, nextStep } = buildDatasetItemsSummaryNextStep({
            datasetId,
            itemCount: v.items.length,
            totalItemCount: v.total,
            offset,
        });
        return buildStorageResponse({ structuredContent, summary, nextStep, toon: true, apifyConsoleUrl });
    },
} as const);
