/**
 * Tool categories and their associated tools.
 * This file is separate from index.ts to avoid circular dependencies.
 *
 * Tools within each category are ordered by the typical workflow:
 * search/discover → get details → execute → check status → get results
 *
 * The final tool ordering presented to MCP clients is determined by tools-loader.ts,
 * which also auto-injects run/storage tools (AUTO_INJECTED_TOOLS) right after call-actor.
 *
 * Each tool entry can be:
 * - A plain ToolEntry — mode-independent, always included
 * - A mode map (e.g. { default: ToolEntry, apps: ToolEntry }) — resolver picks entry[mode]
 * - A partial mode map (e.g. { apps: ToolEntry }) — included only for listed modes
 *
 * Apps vs default mode invariant:
 * Only `*-widget` tools differ between modes — they live in `tools/widgets/` and render an
 * interactive UI element. All non-widget tools (`call-actor`, `get-actor-run`, direct actor
 * tools, `search-actors`, `fetch-actor-details`) share a single implementation across modes.
 * Do NOT add per-mode runtime variants for non-widget tools.
 */
import { HELPER_TOOLS, type HelperToolName } from '../const.js';
import type { ToolEntry } from '../types.js';
import { SERVER_MODE } from '../types.js';
import { addActor } from './actors/add_actor.js';
import { callActorApps, callActorDefault } from './actors/call_actor.js';
import { fetchActorDetails } from './actors/fetch_actor_details.js';
import { searchActors } from './actors/search_actors.js';
import { reportProblem } from './dev/report_problem.js';
import { fetchApifyDocs } from './docs/fetch_apify_docs.js';
import { searchApifyDocs } from './docs/search_apify_docs.js';
import { abortActorRun } from './runs/abort_actor_run.js';
import { getActorRun } from './runs/get_actor_run.js';
import { getActorRunList } from './runs/get_actor_run_list.js';
import { getActorRunLog } from './runs/get_actor_run_log.js';
import { getDataset } from './storage/get_dataset.js';
import { getDatasetItems } from './storage/get_dataset_items.js';
import { getDatasetList } from './storage/get_dataset_list.js';
import { getDatasetSchema } from './storage/get_dataset_schema.js';
import { getKeyValueStore } from './storage/get_key_value_store.js';
import { getKeyValueStoreKeys } from './storage/get_key_value_store_keys.js';
import { getKeyValueStoreList } from './storage/get_key_value_store_list.js';
import { getKeyValueStoreRecord } from './storage/get_key_value_store_record.js';
import { callActorWidget } from './widgets/call_actor_widget.js';
import { fetchActorDetailsWidget } from './widgets/fetch_actor_details_widget.js';
import { getActorRunWidget } from './widgets/get_actor_run_widget.js';
import { searchActorsWidget } from './widgets/search_actors_widget.js';

type ModeMap = Partial<Record<SERVER_MODE, ToolEntry>>;

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
 * with SERVER_MODE keys mapping to their ToolEntry variant.
 *
 * Use {@link getCategoryTools} to resolve entries into concrete ToolEntry arrays for a given mode.
 */
export const toolCategories = {
    experimental: [addActor],
    actors: [
        searchActors,
        fetchActorDetails,
        // call-actor is identical between modes; apps mode appends a widget addendum to the description.
        { default: callActorDefault, apps: callActorApps },
    ],
    docs: [searchApifyDocs, fetchApifyDocs],
    runs: [getActorRun, getActorRunList, getActorRunLog, abortActorRun],
    storage: [
        getDataset,
        getDatasetItems,
        getDatasetSchema,
        getKeyValueStore,
        getKeyValueStoreKeys,
        getKeyValueStoreRecord,
        getDatasetList,
        getKeyValueStoreList,
    ],
    dev: [reportProblem],
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
function resolveCategoryEntries(entries: readonly CategoryToolEntry[], mode: SERVER_MODE): ToolEntry[] {
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
 * Returns mode-resolved tool variants: apps mode gets MCP-Apps-specific implementations
 * (async execution, widget metadata), default mode gets standard implementations.
 * Apps-only tools are excluded in default mode.
 *
 * @param mode - Optional. Use `'default'` or `'apps'`. Defaults to `SERVER_MODE.DEFAULT` when omitted.
 */
export function getCategoryTools(mode: SERVER_MODE = SERVER_MODE.DEFAULT): ToolCategoryMap {
    return Object.fromEntries(
        CATEGORY_NAMES.map((name) => [name, resolveCategoryEntries(toolCategories[name], mode)]),
    ) as ToolCategoryMap;
}

export const toolCategoriesEnabledByDefault: (typeof CATEGORY_NAMES)[number][] = ['actors', 'docs'];

/**
 * Apps-mode pairing: each base tool name maps to its widget sibling.
 * In apps mode, a widget is added to the resolved tool list iff its base
 * tool is already present — see `getToolsForServerMode` in tools_loader.ts.
 *
 * Pairing is intentionally one-way (base → widget). Selecting a widget alone
 * does NOT auto-bring its base; callers asking for widget-only get a UI without
 * the programmatic data tool. To get both, select the base (or both explicitly).
 */
export const WIDGET_BY_BASE_TOOL: ReadonlyMap<HelperToolName, ToolEntry> = new Map([
    [HELPER_TOOLS.STORE_SEARCH, searchActorsWidget],
    [HELPER_TOOLS.ACTOR_GET_DETAILS, fetchActorDetailsWidget],
    [HELPER_TOOLS.ACTOR_CALL, callActorWidget],
    [HELPER_TOOLS.ACTOR_RUNS_GET, getActorRunWidget],
]);
