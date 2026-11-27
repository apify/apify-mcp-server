import type { DatasetClientListItemOptions } from 'apify-client';
import dedent from 'dedent';
import { z } from 'zod';

import type { ApifyClient } from '../../apify_client.js';
import { getApifyAPIPublicBaseUrl } from '../../apify_client.js';
import { HELPER_TOOLS, MAX_INLINE_BYTES, RESOURCE_ID_OR_NAME_MAX_LENGTH } from '../../const.js';
import { buildUrlOnOrigin } from '../../resources/api_resources.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { buildConsoleDatasetUrl, getConsoleLinkContext, VERBATIM_LINKS_NUDGE } from '../../utils/console_link.js';
import { parseCommaSeparatedList, stripQuoteWrappers } from '../../utils/generic.js';
import { logHttpError } from '../../utils/logging.js';
import { respondUserError } from '../../utils/mcp.js';
import { datasetItemsOutputSchema } from '../structured_output_schemas.js';
import {
    buildDatasetItemsSummaryNextStep,
    buildStorageResponse,
    fetchDatasetItemsUnderCap,
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

/**
 * A download link for a page of dataset items, with the query the page was read with. The dataset's
 * `itemsPublicUrl` addresses it by ID and opens without a token whatever the query: under restricted access
 * it carries a signature of the ID only. The API may leave it out, and a failed read loses it: the link is
 * then the items API URL, which may need a token. apify-client's `createItemsPublicUrl` would address a name
 * as `~name`, which a link without a token cannot resolve, and signs only for a token with write access.
 * The query is written as apify-client's `applyQueryParamsToUrl` writes it, with empty lists left out.
 */
async function fetchDatasetItemsDownloadLink(
    client: ApifyClient,
    safeId: string,
    params: DatasetClientListItemOptions,
): Promise<{ url: string; isPublic: boolean }> {
    const datasetClient = client.dataset(safeId);
    let itemsPublicUrl: string | undefined;
    try {
        itemsPublicUrl = (await datasetClient.get())?.itemsPublicUrl;
    } catch (err) {
        logHttpError(err, `Failed to read dataset ${safeId} for its public items URL; falling back to API URL`);
    }
    const url = new URL(itemsPublicUrl ?? buildUrlOnOrigin(`${datasetClient.url}/items`, getApifyAPIPublicBaseUrl()));
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || (Array.isArray(value) && value.length === 0)) continue;
        url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
    }
    return { url: url.href, isPublic: itemsPublicUrl !== undefined };
}

const getDatasetItemsArgs = z.object({
    datasetId: z.string().min(1).max(RESOURCE_ID_OR_NAME_MAX_LENGTH).describe(storageIdArgDescription('dataset')),
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
        A page over ${MAX_INLINE_BYTES} bytes is returned as an error with a link to download it, not as its items.

        USAGE:
        - Use when you need to read data from a dataset (all items or only selected fields).

        USAGE EXAMPLES:
        - user_input: Retrieve results from dataset abc123
        - user_input: Get only metadata.url and title from dataset username~my-dataset`,
    inputSchema: z.toJSONSchema(getDatasetItemsArgs) as ToolInputSchema,
    outputSchema: datasetItemsOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(getDatasetItemsArgs)),
    annotations: {
        title: 'Get dataset items',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client, apifyToken, loadedToolNames } = toolArgs;
        const parsed = getDatasetItemsArgs.parse(args);

        const fields = parseCommaSeparatedList(parsed.fields);
        const omit = parseCommaSeparatedList(parsed.omit);
        const flatten =
            parsed.flatten !== undefined ? parseCommaSeparatedList(parsed.flatten) : extractDotPrefixes(fields);

        const effectiveLimit = parsed.limit ?? DEFAULT_DATASET_ITEMS_LIMIT;
        const datasetId = stripQuoteWrappers(parsed.datasetId);
        const params = {
            clean: parsed.clean,
            offset: parsed.offset,
            limit: effectiveLimit,
            fields,
            omit,
            desc: parsed.desc,
            flatten,
        };
        const found = await fetchStorageByIdOrName(datasetId, async (safeId) =>
            fetchDatasetItemsUnderCap(client, safeId, params),
        );
        if (!found) {
            return respondUserError(storageNotFoundText('dataset', datasetId));
        }
        const { result: v, safeId } = found;
        if (v.isOverLimit) {
            const link = await fetchDatasetItemsDownloadLink(client, safeId, params);
            return respondUserError(
                `This page of dataset '${datasetId}' is over the ${MAX_INLINE_BYTES}-byte response limit. Lower \`limit\`, or use \`fields\` or \`omit\`.\n` +
                    `Download link for the user${link.isPublic ? '' : ' (may require an Apify API token)'}: ${link.url}\n${VERBATIM_LINKS_NUDGE}`,
            );
        }

        const offset = parsed.offset ?? 0;
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
        };

        const { summary, nextStep } = buildDatasetItemsSummaryNextStep({
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
