import dedent from 'dedent';
import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { buildConsoleDatasetUrl, getConsoleLinkContext } from '../../utils/console_link.js';
import { parseCommaSeparatedList, stripQuoteWrappers } from '../../utils/generic.js';
import { respondUserError } from '../../utils/mcp.js';
import { isRecord } from '../api/apify_api_spec.js';
import { datasetItemsOutputSchema } from '../structured_output_schemas.js';
import { buildDatasetItemsSummaryNextStep, buildStorageResponse, catchNotFound } from './storage_helpers.js';

export const DEFAULT_DATASET_ITEMS_LIMIT = 20;

/** `true` keeps the whole value; a map selects its children. */
type FieldTree = Map<string, FieldTree | true>;

const ARRAY_INDEX_SEGMENT = /^(0|[1-9]\d*)$/;

function buildFieldTree(fields: string[], isLiteralKey: (field: string) => boolean = () => false): FieldTree {
    const root: FieldTree = new Map();
    for (const field of fields) {
        if (isLiteralKey(field)) {
            root.set(field, true);
            continue;
        }
        const segments = field.split('.').filter((segment) => segment.length > 0);
        let node = root;
        for (const [i, segment] of segments.entries()) {
            const child = node.get(segment);
            if (child === true) break;
            if (i === segments.length - 1) {
                node.set(segment, true);
                break;
            }
            const next: FieldTree = child ?? new Map();
            node.set(segment, next);
            node = next;
        }
    }
    return root;
}

function mergeFieldTrees(a: FieldTree | true, b: FieldTree | true): FieldTree | true {
    if (a === true || b === true) return true;
    const merged: FieldTree = new Map(a);
    for (const [key, subtree] of b) {
        const existing = merged.get(key);
        merged.set(key, existing === undefined ? subtree : mergeFieldTrees(existing, subtree));
    }
    return merged;
}

function splitArrayTree(tree: FieldTree): { everyElement: FieldTree; byIndex: Map<number, FieldTree | true> } {
    const everyElement: FieldTree = new Map();
    const byIndex = new Map<number, FieldTree | true>();
    for (const [key, subtree] of tree) {
        if (ARRAY_INDEX_SEGMENT.test(key)) byIndex.set(Number(key), subtree);
        else everyElement.set(key, subtree);
    }
    return { everyElement, byIndex };
}

function getElementTree(everyElement: FieldTree, byIndex: Map<number, FieldTree | true>, index: number) {
    const own = byIndex.get(index);
    return own === undefined ? everyElement : mergeFieldTrees(everyElement, own);
}

/** Returns undefined when nothing in `value` matches `tree`. */
function applyFieldTree(value: unknown, tree: FieldTree): unknown {
    if (Array.isArray(value)) {
        const { everyElement, byIndex } = splitArrayTree(tree);
        // Index paths alone cover the array up to the highest index they pick.
        const length =
            everyElement.size > 0 ? value.length : Math.min(value.length, Math.max(-1, ...byIndex.keys()) + 1);
        const projected = value.slice(0, length).map((element, i) => {
            const elementTree = getElementTree(everyElement, byIndex, i);
            if (elementTree === true) return element;
            return elementTree.size > 0 ? applyFieldTree(element, elementTree) : undefined;
        });
        return projected.some((element) => element !== undefined)
            ? projected.map((element, i) => element ?? (isRecord(value[i]) ? {} : null))
            : undefined;
    }
    if (!isRecord(value)) return undefined;
    const result: Record<string, unknown> = {};
    for (const [key, subtree] of tree) {
        if (!Object.hasOwn(value, key)) continue;
        const projected = subtree === true ? value[key] : applyFieldTree(value[key], subtree);
        if (projected !== undefined) result[key] = projected;
    }
    return Object.keys(result).length > 0 ? result : undefined;
}

function removeFieldTree(value: unknown, tree: FieldTree): unknown {
    if (Array.isArray(value)) {
        const { everyElement, byIndex } = splitArrayTree(tree);
        return value.flatMap((element, i) => {
            const elementTree = getElementTree(everyElement, byIndex, i);
            if (elementTree === true) return [];
            return [elementTree.size > 0 ? removeFieldTree(element, elementTree) : element];
        });
    }
    if (!isRecord(value)) return value;
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
        const subtree = tree.get(key);
        if (subtree === true) continue;
        result[key] = subtree ? removeFieldTree(child, subtree) : child;
    }
    return result;
}

/** Projects dot paths without flattening objects or arrays; literal dotted keys take precedence. */
export function projectFields(item: Record<string, unknown>, fields: string[]): Record<string, unknown> {
    const tree = buildFieldTree(fields, (field) => field.includes('.') && Object.hasOwn(item, field));
    const projected = applyFieldTree(item, tree);
    return isRecord(projected) ? projected : {};
}

/** Removes dot paths, including both literal keys and nested matches. */
export function omitFields(item: Record<string, unknown>, omit: string[]): Record<string, unknown> {
    const tree = buildFieldTree(omit);
    for (const field of omit) {
        if (Object.hasOwn(item, field)) tree.set(field, true);
    }
    const result = removeFieldTree(item, tree);
    return isRecord(result) ? result : item;
}

/** The API picks top-level keys; full paths also preserve literal dotted keys. */
export function getApiFields(fields: string[]): string[] {
    const topLevelKeys = fields.map((field) => field.split('.').find((segment) => segment.length > 0) ?? field);
    return [...new Set([...topLevelKeys, ...fields])];
}

function getUnmatchedFields(items: Record<string, unknown>[], fields: string[], omit: string[]): string[] {
    if (items.length === 0) return [];
    return fields.filter(
        (field) =>
            !omit.some((omitted) => field === omitted || field.startsWith(`${omitted}.`)) &&
            items.every((item) => Object.keys(projectFields(item, [field])).length === 0),
    );
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
                'Use dot notation to reach nested objects and arrays of objects (e.g. "metadata.url", "results.title"); ' +
                'a number picks one array element (e.g. "results.0.url"). ' +
                "The output keeps the item's nesting, and arrays keep their positions: an element without the field is {} or null.",
        ),
    omit: z
        .string()
        .optional()
        .describe('Comma-separated list of fields to exclude from results. Dot notation works as in fields.'),
    desc: z.boolean().optional().describe('If true, results are returned in reverse order (newest to oldest).'),
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
        const { args, apifyClient: client, apifyToken, loadedToolNames } = toolArgs;
        const parsed = getDatasetItemsArgs.parse(args);

        const fields = [...new Set(parseCommaSeparatedList(parsed.fields).filter((field) => /[^.]/.test(field)))];
        const omit = parseCommaSeparatedList(parsed.omit).filter((field) => /[^.]/.test(field));
        // The API's `omit` does not reach into arrays of objects, so dotted paths are removed here.
        const dottedOmit = omit.filter((field) => field.includes('.'));

        const effectiveLimit = parsed.limit ?? DEFAULT_DATASET_ITEMS_LIMIT;
        const datasetId = stripQuoteWrappers(parsed.datasetId);
        const v = await catchNotFound(
            client.dataset(datasetId).listItems({
                clean: parsed.clean,
                offset: parsed.offset,
                limit: effectiveLimit,
                fields: getApiFields(fields),
                omit: omit.filter((field) => !field.includes('.')),
                desc: parsed.desc,
            }),
        );
        if (!v) {
            return respondUserError(`Dataset '${datasetId}' not found.`);
        }

        const items = v.items.map((item) => {
            const projected = fields.length > 0 ? projectFields(item, fields) : item;
            return dottedOmit.length > 0 ? omitFields(projected, dottedOmit) : projected;
        });
        const unmatchedFields = getUnmatchedFields(v.items, fields, omit);
        const offset = parsed.offset ?? 0;
        const apifyConsoleUrl = buildConsoleDatasetUrl(await getConsoleLinkContext(apifyToken, client), datasetId);
        const structuredContent = {
            datasetId,
            apifyConsoleUrl,
            items,
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
            loadedToolNames,
            unmatchedFields,
        });
        return buildStorageResponse({ structuredContent, summary, nextStep, apifyConsoleUrl });
    },
} as const);
