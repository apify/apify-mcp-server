/**
 * Tool categories and their associated tools.
 * This file is separate from index.ts to avoid circular dependencies.
 *
 * Tools within each category are ordered by the typical workflow:
 * search/discover → get details → execute → check status → get results
 *
 * The final tool ordering presented to MCP clients is determined by tools-loader.ts,
 * which also auto-injects get-actor-run and get-actor-output right after call-actor.
 *
 * Each tool entry can be:
 * - A plain ToolEntry — mode-independent, always included
 * - A mode map (e.g. { default: ToolEntry, openai: ToolEntry }) — resolver picks entry[mode]
 * - A partial mode map (e.g. { openai: ToolEntry }) — included only for listed modes
 */
import type { ServerMode, ToolEntry } from '../types.js';
import { abortActorRun } from './common/abort_actor_run.js';
import { addTool } from './common/add_actor.js';
import { getUserDatasetsList } from './common/dataset_collection.js';
import { fetchApifyDocsTool } from './common/fetch_apify_docs.js';
import { getActorOutput } from './common/get_actor_output.js';
import { getActorRunLog } from './common/get_actor_run_log.js';
import { getDataset } from './common/get_dataset.js';
import { getDatasetItems } from './common/get_dataset_items.js';
import { getDatasetSchema } from './common/get_dataset_schema.js';
import { getHtmlSkeleton } from './common/get_html_skeleton.js';
import { getKeyValueStore } from './common/get_key_value_store.js';
import { getKeyValueStoreKeys } from './common/get_key_value_store_keys.js';
import { getKeyValueStoreRecord } from './common/get_key_value_store_record.js';
import { getUserKeyValueStoresList } from './common/key_value_store_collection.js';
import { getUserRunsList } from './common/run_collection.js';
import { searchApifyDocsTool } from './common/search_apify_docs.js';
import { defaultCallActor } from './default/call_actor.js';
import { defaultFetchActorDetails } from './default/fetch_actor_details.js';
import { defaultGetActorRun } from './default/get_actor_run.js';
import { defaultSearchActors } from './default/search_actors.js';
import { openaiCallActor } from './openai/call_actor.js';
import { openaiFetchActorDetails } from './openai/fetch_actor_details.js';
import { fetchActorDetailsInternalTool } from './openai/fetch_actor_details_internal.js';
import { openaiGetActorRun } from './openai/get_actor_run.js';
import { openaiSearchActors } from './openai/search_actors.js';
import { searchActorsInternalTool } from './openai/search_actors_internal.js';

/**
 * A mode map: maps one or more ServerMode keys to their ToolEntry variant.
 * - All modes present → each mode gets its own implementation
 * - Subset of modes → tool is only included for those modes
 */
type ModeMap = Partial<Record<ServerMode, ToolEntry>>;

/** A category tool entry: plain ToolEntry (mode-independent) or a mode map. */
type CategoryToolEntry = ToolEntry | ModeMap;

/** A plain ToolEntry always has a `name` property; mode maps never do. */
function isModeMap(entry: CategoryToolEntry): entry is ModeMap {
    return !('name' in entry);
}

/**
 * Unified tool category definitions — single source of truth.
 *
 * Each entry is either a plain ToolEntry (mode-independent) or a mode map
 * with ServerMode keys mapping to their ToolEntry variant.
 *
 * Use {@link getCategoryTools} to resolve entries into concrete ToolEntry arrays for a given mode.
 */
export const toolCategories = {
    experimental: [
        addTool,
    ],
    actors: [
        { default: defaultSearchActors, openai: openaiSearchActors },
        { default: defaultFetchActorDetails, openai: openaiFetchActorDetails },
        { default: defaultCallActor, openai: openaiCallActor },
    ],
    ui: [
        { openai: searchActorsInternalTool },
        { openai: fetchActorDetailsInternalTool },
    ],
    docs: [
        searchApifyDocsTool,
        fetchApifyDocsTool,
    ],
    runs: [
        { default: defaultGetActorRun, openai: openaiGetActorRun },
        getUserRunsList,
        getActorRunLog,
        abortActorRun,
    ],
    storage: [
        getDataset,
        getDatasetItems,
        getDatasetSchema,
        getActorOutput,
        getKeyValueStore,
        getKeyValueStoreKeys,
        getKeyValueStoreRecord,
        getUserDatasetsList,
        getUserKeyValueStoresList,
    ],
    dev: [
        getHtmlSkeleton,
    ],
} satisfies Record<string, CategoryToolEntry[]>;

/**
 * Canonical list of all tool category names, derived from toolCategories keys.
 */
export const CATEGORY_NAMES = Object.keys(toolCategories) as (keyof typeof toolCategories)[];

/** Set of known category names for O(1) membership checks. */
export const CATEGORY_NAME_SET: ReadonlySet<string> = new Set<string>(CATEGORY_NAMES);

/** Map from category name to an array of resolved tool entries. */
export type ToolCategoryMap = Record<(typeof CATEGORY_NAMES)[number], ToolEntry[]>;

/**
 * Resolve a single category's tool entries for the given server mode.
 *
 * For each entry:
 * - Plain ToolEntry (has `name`) → always included, mode-independent
 * - ModeMap → look up `entry[mode]`; included only if the mode key exists
 */
function resolveCategoryEntries(entries: readonly CategoryToolEntry[], mode: ServerMode): ToolEntry[] {
    const result: ToolEntry[] = [];
    for (const entry of entries) {
        if (isModeMap(entry)) {
            const tool = entry[mode];
            if (tool) {
                result.push(tool);
            }
        } else {
            result.push(entry);
        }
    }
    return result;
}

/**
 * Resolve tool categories for a given server mode.
 *
 * Returns mode-resolved tool variants: openai mode gets openai-specific implementations
 * (async execution, widget metadata), default mode gets standard implementations.
 * Openai-only tools are excluded in default mode.
 *
 * @param mode - Required. Use `'default'` or `'openai'`.
 *   Made explicit (no default value) to prevent accidentally serving wrong-mode tools.
 */
export function getCategoryTools(mode: ServerMode = 'default'): ToolCategoryMap {
    return Object.fromEntries(
        CATEGORY_NAMES.map((name) => [name, resolveCategoryEntries(toolCategories[name], mode)]),
    ) as ToolCategoryMap;
}

export const toolCategoriesEnabledByDefault: (typeof CATEGORY_NAMES)[number][] = [
    'actors',
    'docs',
];
