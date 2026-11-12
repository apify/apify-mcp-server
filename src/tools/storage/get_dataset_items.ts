import dedent from 'dedent';
import { z } from 'zod';

import { getApifyAPIPublicBaseUrl } from '../../apify_client.js';
import { HELPER_TOOLS, MAX_INLINE_BYTES } from '../../const.js';
import { buildUrlOnOrigin } from '../../resources/api_resources.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { buildConsoleDatasetUrl, getConsoleLinkContext } from '../../utils/console_link.js';
import { parseCommaSeparatedList, stripQuoteWrappers } from '../../utils/generic.js';
import { respondUserError } from '../../utils/mcp.js';
import { datasetItemsOutputSchema } from '../structured_output_schemas.js';
import { readDatasetItems } from './dataset_items_read.js';
import {
    buildDatasetItemsSummaryNextStep,
    buildStorageResponse,
    fetchStorageByIdOrName,
    resolveStorageId,
    storageIdArgDescription,
    storageNotFoundText,
} from './storage_helpers.js';

export const DEFAULT_DATASET_ITEMS_LIMIT = 20;

/**
 * Top-level prefixes of dotted `fields` to flatten. Apify's `flatten` recurses, so the first
 * segment suffices. A prefix also selected on its own stays whole: flattening it would remove it.
 */
export function extractDotPrefixes(fields: string[]): string[] {
    const prefixes = new Set<string>();
    for (const field of fields) {
        const dotIndex = field.indexOf('.');
        const prefix = field.slice(0, dotIndex);
        if (dotIndex > 0 && !fields.includes(prefix)) {
            prefixes.add(prefix);
        }
    }
    return [...prefixes];
}

/** The request that read a page, as the result text describes it. */
type ItemsRequest = { offset: number; clean: boolean; desc: boolean; hasProjection: boolean };

/** The error of a first item over `MAX_INLINE_BYTES` on its own, with a link to download it whole. */
function buildItemTooLargeText(itemsUrl: string, { offset, clean, desc, hasProjection }: ItemsRequest): string {
    const query = new URLSearchParams({
        offset: String(offset),
        limit: '1',
        ...(desc && { desc: '1' }),
        ...(clean && { clean: '1' }),
    });
    return (
        `The first item at offset=${offset} is larger than ${MAX_INLINE_BYTES} bytes on its own, so it is not returned.` +
        `${hasProjection ? '' : ' fields or omit return part of it.'}` +
        ` The whole item can be downloaded from ${itemsUrl}?${query} (requires your Apify API token).`
    );
}

/** {summary, nextStep} of a page cut at `MAX_INLINE_BYTES`: the whole items that fit, and where to continue. */
function buildCutPageSummaryNextStep(
    itemCount: number,
    limit: number,
    nextOffset: number,
    { clean, hasProjection }: ItemsRequest,
): { summary: string; nextStep: string } {
    const summary =
        `Returned ${itemCount} of the ${limit} requested items: ` +
        `the next item would pass the ${MAX_INLINE_BYTES}-byte response limit.`;
    const nextStep =
        `Call ${HELPER_TOOLS.DATASET_GET_ITEMS} again with offset=${nextOffset} to fetch the next page.` +
        `${clean ? ' With clean=true the offset also counts the empty items the API skips, so that page can repeat some of these items; it skips none.' : ''}` +
        `${hasProjection ? '' : ' fields or omit return fewer fields per item, so more items fit.'}`;
    return { summary, nextStep };
}

const getDatasetItemsArgs = z.object({
    datasetId: z.string().min(1).describe(storageIdArgDescription('dataset')),
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
        .describe(
            `Maximum number of items to return. Default is ${DEFAULT_DATASET_ITEMS_LIMIT}. A call returns fewer when the items pass ${MAX_INLINE_BYTES} bytes.`,
        ),
    fields: z.string().optional().describe(dedent`
            Comma-separated list of fields to include in results.
            Fields in output are sorted as specified.
            Use dot notation for nested objects (e.g. "metadata.url"); the server auto-flattens parent prefixes and returns flat keys, unless the parent itself is listed (e.g. "metadata,metadata.url" returns metadata whole).
            A dotted path to or through an array (e.g. "results.url") returns nothing: select its top-level field (e.g. "results") for every element.
            Items that have none of the requested fields come back as {}, or are dropped when clean=true.
        `),
    omit: z.string().optional().describe('Comma-separated list of fields to exclude from results.'),
    desc: z.boolean().optional().describe('If true, results are returned in reverse order (newest to oldest).'),
    flatten: z.string().optional().describe(dedent`
            Comma-separated list of fields to flatten (e.g. flatten="metadata" turns {"metadata":{"url":"x"}} into {"metadata.url":"x"}).
            Normally derived automatically from dot-notation in \`fields\`; specify only as a diagnostic override.
        `),
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
        Returns the rows themselves, not dataset metadata, counts, or a schema.
        When the user provides a datasetId and asks to retrieve results, output, data, or rows, call this tool directly.
        Default limit is ${DEFAULT_DATASET_ITEMS_LIMIT}. Use clean=true to skip empty items and hidden fields.
        One call returns up to ${MAX_INLINE_BYTES} bytes of whole items; the result then gives the offset to continue from.

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
        const { args, apifyClient: client, apifyToken, loadedToolNames, signal } = toolArgs;
        const parsed = getDatasetItemsArgs.parse(args);

        const fields = parseCommaSeparatedList(parsed.fields);
        const omit = parseCommaSeparatedList(parsed.omit);
        const flatten =
            parsed.flatten !== undefined ? parseCommaSeparatedList(parsed.flatten) : extractDotPrefixes(fields);

        const effectiveLimit = parsed.limit ?? DEFAULT_DATASET_ITEMS_LIMIT;
        const datasetId = stripQuoteWrappers(parsed.datasetId);
        const found = await fetchStorageByIdOrName(datasetId, async (safeId) =>
            readDatasetItems(
                client,
                safeId,
                {
                    clean: parsed.clean,
                    offset: parsed.offset,
                    limit: effectiveLimit,
                    fields,
                    omit,
                    desc: parsed.desc,
                    flatten,
                },
                signal,
            ),
        );
        if (!found) {
            return respondUserError(storageNotFoundText('dataset', datasetId));
        }
        const { result: v, safeId } = found;

        const offset = parsed.offset ?? 0;
        const request: ItemsRequest = {
            offset,
            clean: parsed.clean === true,
            desc: parsed.desc === true,
            hasProjection: fields.length > 0 || omit.length > 0,
        };
        if (v.isCut && v.items.length === 0) {
            // `client.dataset(safeId).url` is on the egress origin; clients get the client-facing one.
            const itemsUrl = `${buildUrlOnOrigin(client.dataset(safeId).url, getApifyAPIPublicBaseUrl())}/items`;
            return respondUserError(buildItemTooLargeText(itemsUrl, request));
        }
        const linkContext = await getConsoleLinkContext(apifyToken, client);
        const apifyConsoleUrl = linkContext
            ? buildConsoleDatasetUrl(
                  linkContext,
                  await resolveStorageId(safeId, async (id) => client.dataset(id).get()),
              )
            : undefined;
        const structuredContent = {
            datasetId,
            apifyConsoleUrl,
            items: v.items,
            itemCount: v.items.length,
            totalItemCount: v.total,
            offset,
            limit: effectiveLimit,
            ...(v.isCut && { nextOffset: offset + v.items.length }),
        };

        const { summary, nextStep } = v.isCut
            ? buildCutPageSummaryNextStep(v.items.length, effectiveLimit, offset + v.items.length, request)
            : buildDatasetItemsSummaryNextStep({
                  datasetId,
                  itemCount: v.items.length,
                  totalItemCount: v.total,
                  offset,
                  limit: effectiveLimit,
                  loadedToolNames,
              });
        return buildStorageResponse({ structuredContent, summary, nextStep, apifyConsoleUrl });
    },
} as const);
