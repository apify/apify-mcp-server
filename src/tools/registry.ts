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

/** Fresh copy of every category's tools. `mode` is unused (no category tool varies by mode) but stays in the `internals.js` signature. */
export function getCategoryTools(_mode: SERVER_MODE = SERVER_MODE.DEFAULT): ToolCategoryMap {
    return Object.fromEntries(CATEGORY_NAMES.map((name) => [name, [...toolCategories[name]]])) as ToolCategoryMap;
}

export const toolCategoriesEnabledByDefault: (typeof CATEGORY_NAMES)[number][] = ['actors', 'docs'];

/** Every widget, paired or not — for direct `?tools=` selection and internal-name classification in tools_loader.ts. */
export const ALL_WIDGET_TOOLS: readonly ToolEntry[] = [
    searchActorsWidget,
    fetchActorDetailsWidget,
    callActorWidget,
    getActorRunWidget,
];

/**
 * Apps-mode auto-pairing: a widget is added iff its base tool is present — see
 * `getToolsForServerMode` in tools_loader.ts. `call-actor`/`get-actor-run` widgets don't pair (low
 * usage); they stay directly selectable via `ALL_WIDGET_TOOLS`.
 *
 * Pairing is one-way (base → widget): selecting a widget alone never auto-brings its base.
 */
export const WIDGET_BY_BASE_TOOL: ReadonlyMap<HelperToolName, ToolEntry> = new Map([
    [HELPER_TOOLS.STORE_SEARCH, searchActorsWidget],
    [HELPER_TOOLS.ACTOR_GET_DETAILS, fetchActorDetailsWidget],
]);
