import dedent from 'dedent';
import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { buildConsoleDatasetUrl, getConsoleLinkContext } from '../../utils/console_link.js';
import { parseCommaSeparatedList, stripQuoteWrappers } from '../../utils/generic.js';
import { respondUserError } from '../../utils/mcp.js';
import { datasetItemsOutputSchema } from '../structured_output_schemas.js';
import { buildDatasetItemsSummaryNextStep, buildStorageResponse, catchNotFound } from './storage_helpers.js';

export const DEFAULT_DATASET_ITEMS_LIMIT = 20;

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
        .describe(`Maximum number of items to return. Default is ${DEFAULT_DATASET_ITEMS_LIMIT}.`),
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
    name: HELPER_TOOLS.DATASET_GET_ITEMS,
    title: 'Get dataset items',
    description: dedent`
        Get items (rows) from a dataset — the output/results produced by an Actor run.
        Not metadata or schema — use ${HELPER_TOOLS.DATASET_GET} for counts and the field list, ${HELPER_TOOLS.DATASET_SCHEMA_GET} for a JSON schema from a sample.
        When the user provides a datasetId and asks to retrieve results, output, data, or rows, call this tool directly — do not call ${HELPER_TOOLS.DATASET_GET} first.
        Default limit is ${DEFAULT_DATASET_ITEMS_LIMIT}. Use clean=true to skip empty items and hidden fields.

        USAGE:
        - Use when you need to read data from a dataset (all items or only selected fields).

        USAGE EXAMPLES:
        - user_input: Retrieve results from dataset abc123
        - user_input: Get only metadata.url and title from dataset username~my-dataset`,
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
        const { args, apifyClient: client, apifyToken, apifyMcpServer } = toolArgs;
        const parsed = getDatasetItemsArgs.parse(args);

        const fields = parseCommaSeparatedList(parsed.fields);
        const omit = parseCommaSeparatedList(parsed.omit);
        const flatten =
            parsed.flatten !== undefined ? parseCommaSeparatedList(parsed.flatten) : extractDotPrefixes(fields);

        const effectiveLimit = parsed.limit ?? DEFAULT_DATASET_ITEMS_LIMIT;
        const datasetId = stripQuoteWrappers(parsed.datasetId);
        const v = await catchNotFound(
            client.dataset(datasetId).listItems({
                clean: parsed.clean,
                offset: parsed.offset,
                limit: effectiveLimit,
                fields,
                omit,
                desc: parsed.desc,
                flatten,
            }),
        );
        if (!v) {
            return respondUserError(`Dataset '${datasetId}' not found.`);
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
            loadedToolNames: apifyMcpServer.listToolNames(),
        });
        return buildStorageResponse({ structuredContent, summary, nextStep, apifyConsoleUrl });
    },
} as const);
