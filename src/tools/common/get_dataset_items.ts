import dedent from 'dedent';
import { z } from 'zod';

import {
    DATASET_ITEMS_MAX_BYTES,
    HelperTools,
    HTTP_NOT_FOUND,
    MAX_DATASET_ITEMS_LIMIT,
    NARROW_OUTPUT_HINT,
} from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { buildConsoleDatasetUrl, getConsoleLinkContext } from '../../utils/console_link.js';
import { encodeToon } from '../../utils/encode_text.js';
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

/**
 * Largest prefix length of `items` whose encoded `structuredContent` stays within
 * {@link DATASET_ITEMS_MAX_BYTES}. Measured on the TOON text (`content[0]`) — which is exactly what the
 * model receives: the chat wraps MCP tools with `schemas: "automatic"`, so the AI SDK serializes the
 * result via `mcpToModelOutput`, which forwards only `content` (text/image parts) and drops
 * `structuredContent`. Binary-searches the prefix so encoding runs O(log n) times. Returns at least 1
 * when any item exists, so an oversized single item is still surfaced (with the narrow-output hint)
 * rather than returning an empty page.
 */
function maxItemsWithinByteCap<T>(items: T[], buildStructuredContent: (items: T[]) => Record<string, unknown>): number {
    const encodedBytes = (n: number): number =>
        Buffer.byteLength(encodeToon(buildStructuredContent(items.slice(0, n))));
    if (items.length === 0 || encodedBytes(items.length) <= DATASET_ITEMS_MAX_BYTES) return items.length;

    let lo = 1; // keep at least one item even if it alone exceeds the cap
    let hi = items.length;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (encodedBytes(mid) <= DATASET_ITEMS_MAX_BYTES) lo = mid;
        else hi = mid - 1;
    }
    return lo;
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
    title: 'Get dataset items',
    description: dedent`
        Retrieve dataset items with pagination, sorting, and field selection.
        For nested fields use dot notation (e.g., fields="metadata.url") — the server auto-flattens parent prefixes.
        Defaults limit to ${DEFAULT_DATASET_ITEMS_LIMIT}. Use clean=true to skip empty items and hidden fields.

        The results will include items along with pagination info (limit, offset) and total count.

        USAGE:
        - Use when you need to read data from a dataset (all items or only selected fields).

        USAGE EXAMPLES:
        - user_input: Get first 20 items from dataset abd123
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

        // Layer 1: clamp the requested count before fetching — the model freely asks for far more
        // (real traces: up to 1226), so bound what we transfer and let pagination serve the rest.
        const effectiveLimit = Math.min(parsed.limit ?? DEFAULT_DATASET_ITEMS_LIMIT, MAX_DATASET_ITEMS_LIMIT);
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
        const buildStructuredContent = (items: typeof v.items): Record<string, unknown> => ({
            datasetId,
            apifyConsoleUrl,
            items,
            itemCount: items.length,
            totalItemCount: v.total,
            offset,
            limit: effectiveLimit,
        });

        // Layer 2: byte-cap the encoded response — catches the case where even the clamped page is huge
        // (a few large items). Drop trailing items until the on-the-wire payload fits; pagination serves
        // the rest. `totalItemCount` stays the dataset total so the next-step offset math is exact.
        const keep = maxItemsWithinByteCap(v.items, buildStructuredContent);
        const items = keep < v.items.length ? v.items.slice(0, keep) : v.items;
        const truncatedByBytes = keep < v.items.length;
        const structuredContent = buildStructuredContent(items);

        const { summary, nextStep } = buildDatasetItemsSummaryNextStep({
            datasetId,
            // Use the actually-returned count, not the requested limit, so the next page resumes
            // exactly where this one ended and no items are skipped.
            itemCount: items.length,
            totalItemCount: v.total,
            offset,
            loadedToolNames: apifyMcpServer.listToolNames(),
        });
        // When the byte cap (not just paging) forced the cut, steer the model to shrink per-item size so
        // the next page can carry more rows instead of getting capped to the same small count again.
        const cappedNextStep = truncatedByBytes
            ? `Response capped at ${DATASET_ITEMS_MAX_BYTES} bytes (returned ${items.length} items). ${nextStep} To fit more rows per page, ${NARROW_OUTPUT_HINT}.`
            : nextStep;
        return buildStorageResponse({
            structuredContent,
            summary,
            nextStep: cappedNextStep,
            toon: true,
            apifyConsoleUrl,
        });
    },
} as const);
