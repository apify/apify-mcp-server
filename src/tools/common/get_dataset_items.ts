import dedent from 'dedent';
import { z } from 'zod';

import { FAILURE_CATEGORY, HelperTools, TOOL_STATUS } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { parseCommaSeparatedList } from '../../utils/generic.js';
import { buildMCPResponse } from '../../utils/mcp.js';
import { datasetItemsOutputSchema } from '../structured_output_schemas.js';

const DEFAULT_DATASET_ITEMS_LIMIT = 100;

/**
 * Derive the `flatten` set from dot-notation `fields` entries.
 * Picks the unique top-level prefix for each dotted path.
 * Example: `["metadata.url", "crawl.statusCode", "title"]` → `["metadata", "crawl"]`.
 */
export function deriveFlattenFromFields(fields: string[]): string[] {
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
    runId: z.string()
        .min(1)
        .optional()
        .describe('Actor run ID. Server resolves the run\'s default dataset. Provide exactly one of runId or datasetId.'),
    datasetId: z.string()
        .min(1)
        .optional()
        .describe('Dataset ID or username~dataset-name. Provide exactly one of runId or datasetId.'),
    clean: z.boolean().optional()
        .describe('If true, returns only non-empty items and skips hidden fields (starting with #). Shortcut for skipHidden=true and skipEmpty=true.'),
    offset: z.number().optional()
        .describe('Number of items to skip at the start. Default is 0.'),
    limit: z.number().default(DEFAULT_DATASET_ITEMS_LIMIT).optional()
        .describe(`Maximum number of items to return. Defaults to ${DEFAULT_DATASET_ITEMS_LIMIT}.`),
    fields: z.string().optional()
        .describe('Comma-separated list of fields to include in results. '
            + 'Fields in output are sorted as specified. '
            + 'Use dot notation for nested objects (e.g. "metadata.url"); the server auto-flattens parent prefixes.'),
    omit: z.string().optional()
        .describe('Comma-separated list of fields to exclude from results.'),
    desc: z.boolean().optional()
        .describe('If true, results are returned in reverse order (newest to oldest).'),
    flatten: z.string().optional()
        .describe('Comma-separated list of fields to flatten (e.g. flatten="metadata" turns {"metadata":{"url":"x"}} into {"metadata.url":"x"}). '
            + 'Normally derived automatically from dot-notation in `fields`; specify only as a diagnostic override.'),
}).refine(
    (data) => (data.runId !== undefined) !== (data.datasetId !== undefined),
    { message: 'Provide exactly one of runId or datasetId.' },
);

/**
 * https://docs.apify.com/api/v2/dataset-items-get
 */
export const getDatasetItems: ToolEntry = Object.freeze({
    type: 'internal',
    name: HelperTools.DATASET_GET_ITEMS,
    description: dedent`
        Retrieve dataset items with pagination, sorting, and field selection.
        Provide exactly one of runId or datasetId; runId resolves to the run's default dataset.
        For nested fields use dot notation (e.g., fields="metadata.url") — the server auto-flattens parent prefixes.
        Defaults limit to ${DEFAULT_DATASET_ITEMS_LIMIT}. Use clean=true to skip empty items and hidden fields.

        The results will include items along with pagination info (limit, offset) and total count.

        USAGE:
        - Use when you need to read data from a dataset or an Actor run's output (all items or only selected fields).

        USAGE EXAMPLES:
        - user_input: Get items from run y2h7sK3Wc
        - user_input: Get first 100 items from dataset abd123
        - user_input: Get only metadata.url and title from run y2h7sK3Wc`,
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
        const { args, apifyClient: client } = toolArgs;
        const parseResult = getDatasetItemsArgs.safeParse(args);
        if (!parseResult.success) {
            const message = parseResult.error.issues.map((i) => i.message).join('; ');
            return buildMCPResponse({
                texts: [`Invalid arguments for get-dataset-items: ${message}`],
                isError: true,
                telemetry: { toolStatus: TOOL_STATUS.SOFT_FAIL, failureCategory: FAILURE_CATEGORY.INVALID_INPUT },
            });
        }
        const parsed = parseResult.data;

        // Resolve dataset ID from runId when provided.
        let datasetId: string;
        if (parsed.runId) {
            const run = await client.run(parsed.runId).get();
            if (!run) {
                return buildMCPResponse({
                    texts: [`Run '${parsed.runId}' not found.`],
                    isError: true,
                    telemetry: { toolStatus: TOOL_STATUS.SOFT_FAIL, failureCategory: FAILURE_CATEGORY.INVALID_INPUT },
                });
            }
            if (!run.defaultDatasetId) {
                return buildMCPResponse({
                    texts: [`Run '${parsed.runId}' has no default dataset.`],
                    isError: true,
                    telemetry: { toolStatus: TOOL_STATUS.SOFT_FAIL, failureCategory: FAILURE_CATEGORY.INVALID_INPUT },
                });
            }
            datasetId = run.defaultDatasetId;
        } else {
            // Refine guarantees datasetId is set when runId is not.
            datasetId = parsed.datasetId as string;
        }

        // Convert comma-separated strings to arrays
        const fields = parseCommaSeparatedList(parsed.fields);
        const omit = parseCommaSeparatedList(parsed.omit);
        // Auto-derive flatten from dot-notation `fields` when caller did not pass `flatten`.
        const flatten = parsed.flatten !== undefined
            ? parseCommaSeparatedList(parsed.flatten)
            : deriveFlattenFromFields(fields);

        const v = await client.dataset(datasetId).listItems({
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
                texts: [`Dataset '${datasetId}' not found.`],
                isError: true,
                telemetry: { toolStatus: TOOL_STATUS.SOFT_FAIL },
            });
        }

        const structuredContent = {
            datasetId,
            items: v.items,
            itemCount: v.items.length,
            totalItemCount: v.total,
            offset: parsed.offset ?? 0,
            limit: parsed.limit,
        };

        return { content: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(v)}\n\`\`\`` }], structuredContent };
    },
} as const);
