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
 * Apps vs default mode invariant:
 * Only `*-widget` tools differ between modes — they live in `tools/widgets/` and render an
 * interactive UI element. All non-widget tools (`call-actor`, `get-actor-run`, direct actor
 * tools, `search-actors`, `fetch-actor-details`) share a single implementation across modes.
 * Do NOT add per-mode runtime variants for non-widget tools.
 */
import { HELPER_TOOLS, type HelperToolName } from '../const.js';
import type { ToolEntry } from '../types.js';
import { SERVER_MODE } from '../types.js';
import { callActor } from './actors/call_actor.js';
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
import { createActorTask } from './tasks/create_actor_task.js';
import { getActorTask } from './tasks/get_actor_task.js';
import { publishActorTask } from './tasks/publish_actor_task.js';
import { unpublishActorTask } from './tasks/unpublish_actor_task.js';
import { updateActorTask } from './tasks/update_actor_task.js';
import { callActorWidget } from './widgets/call_actor_widget.js';
import { fetchActorDetailsWidget } from './widgets/fetch_actor_details_widget.js';
import { getActorRunWidget } from './widgets/get_actor_run_widget.js';
import { searchActorsWidget } from './widgets/search_actors_widget.js';

/** Unified tool category definitions — single source of truth. */
export const toolCategories = {
    actors: [searchActors, fetchActorDetails, callActor],
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
    tasks: [createActorTask, getActorTask, updateActorTask, publishActorTask, unpublishActorTask],
    dev: [reportProblem],
} satisfies Record<string, ToolEntry[]>;

/**
 * Canonical list of all tool category names, derived from toolCategories keys.
 */
export const CATEGORY_NAMES = Object.keys(toolCategories) as (keyof typeof toolCategories)[];

/** Set of known category names for O(1) membership checks. */
export const CATEGORY_NAME_SET: ReadonlySet<string> = new Set<string>(CATEGORY_NAMES);

/** Map from category name to an array of resolved tool entries. */
export type ToolCategoryMap = Record<(typeof CATEGORY_NAMES)[number], ToolEntry[]>;

/**
 * Resolve tool categories for a given server mode. No category tool currently varies by mode
 * (widgets are a separate, non-category surface — see ALL_WIDGET_TOOLS/WIDGET_BY_BASE_TOOL below);
 * `mode` stays part of the signature for API stability with apify-mcp-server-internal.
 */
export function getCategoryTools(_mode: SERVER_MODE = SERVER_MODE.DEFAULT): ToolCategoryMap {
    return Object.fromEntries(CATEGORY_NAMES.map((name) => [name, [...toolCategories[name]]])) as ToolCategoryMap;
}

export const toolCategoriesEnabledByDefault: (typeof CATEGORY_NAMES)[number][] = ['actors', 'docs'];

/**
 * All widget tools, regardless of auto-pairing. Every widget is always directly selectable via
 * `?tools=<widget-name>` and always counts as a known internal tool (never misclassified as an
 * Actor ID) — see `ALL_INTERNAL_TOOL_NAMES` and the direct-selection lookup in tools_loader.ts.
 * Selecting a widget alone never auto-brings its base tool (pairing, below, is one-way and only
 * covers two of these four).
 */
export const ALL_WIDGET_TOOLS: readonly ToolEntry[] = [
    searchActorsWidget,
    fetchActorDetailsWidget,
    callActorWidget,
    getActorRunWidget,
];

/**
 * Apps-mode auto-pairing: each base tool name maps to its widget sibling. In apps mode, a widget
 * is added to the resolved tool list automatically iff its base tool is already present — see
 * `getToolsForServerMode` in tools_loader.ts. Only these two tools auto-pair; `call-actor` and
 * `get-actor-run` do not (low usage) — their widgets remain directly selectable (`ALL_WIDGET_TOOLS`
 * above), just never auto-added.
 *
 * Pairing is intentionally one-way (base → widget) even for the two tools that do pair. Selecting
 * a widget alone does NOT auto-bring its base; callers asking for widget-only get a UI without
 * the programmatic data tool. To get both, select the base (or both explicitly).
 */
export const WIDGET_BY_BASE_TOOL: ReadonlyMap<HelperToolName, ToolEntry> = new Map([
    [HELPER_TOOLS.STORE_SEARCH, searchActorsWidget],
    [HELPER_TOOLS.ACTOR_GET_DETAILS, fetchActorDetailsWidget],
]);
