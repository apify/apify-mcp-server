/**
 * Tool categories and their associated tools.
 * This file is separate from index.ts to avoid circular dependencies.
 *
 * Tools within each category are ordered by the typical workflow:
 * search/discover → get details → execute → check status → get results
 *
 * The final tool ordering presented to MCP clients is determined by tools-loader.ts,
 * which also auto-injects get-actor-run and get-actor-output right after call-actor.
 */
import type { ToolEntry, UiMode } from '../types.js';
import { callActor } from './actor.js';
import { getDataset, getDatasetItems, getDatasetSchema } from './common/dataset.js';
import { getUserDatasetsList } from './common/dataset_collection.js';
import { fetchApifyDocsTool } from './common/fetch-apify-docs.js';
import { getActorOutput } from './common/get-actor-output.js';
import { getHtmlSkeleton } from './common/get-html-skeleton.js';
import { addTool } from './common/helpers.js';
import { getKeyValueStore, getKeyValueStoreKeys, getKeyValueStoreRecord } from './common/key_value_store.js';
import { getUserKeyValueStoresList } from './common/key_value_store_collection.js';
import { abortActorRun, getActorRun, getActorRunLog } from './common/run.js';
import { getUserRunsList } from './common/run_collection.js';
import { searchApifyDocsTool } from './common/search-apify-docs.js';
import { defaultCallActor } from './default/call-actor.js';
import { defaultFetchActorDetails } from './default/fetch-actor-details.js';
import { defaultGetActorRun } from './default/get-actor-run.js';
import { defaultSearchActors } from './default/search-actors.js';
import { fetchActorDetailsTool } from './fetch-actor-details.js';
import { openaiCallActor } from './openai/call-actor.js';
import { openaiFetchActorDetails } from './openai/fetch-actor-details.js';
import { fetchActorDetailsInternalTool } from './openai/fetch-actor-details-internal.js';
import { openaiGetActorRun } from './openai/get-actor-run.js';
import { openaiSearchActors } from './openai/search-actors.js';
import { searchActorsInternalTool } from './openai/search-actors-internal.js';
import { searchActors } from './store_collection.js';

/**
 * Canonical list of all tool category names.
 * Used to derive the ToolCategory type and validate category maps at compile time.
 */
export const CATEGORY_NAMES = ['experimental', 'actors', 'ui', 'docs', 'runs', 'storage', 'dev'] as const;

/** Map from category name to an array of tool entries. */
export type ToolCategoryMap = Record<(typeof CATEGORY_NAMES)[number], ToolEntry[]>;

/**
 * Static tool categories using adapter tools that dispatch at runtime based on uiMode.
 *
 * @deprecated Use {@link buildCategories} instead, which returns mode-resolved tool variants
 * directly without runtime dispatching. This static map will be removed once the tools-loader
 * is refactored to use buildCategories().
 */
export const toolCategories: ToolCategoryMap = {
    experimental: [
        addTool,
    ],
    actors: [
        searchActors,
        fetchActorDetailsTool,
        callActor,
    ],
    ui: [
        searchActorsInternalTool,
        fetchActorDetailsInternalTool,
    ],
    docs: [
        searchApifyDocsTool,
        fetchApifyDocsTool,
    ],
    runs: [
        getActorRun,
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
};

/**
 * Build tool categories for a given UI mode.
 *
 * Returns the same category names as {@link toolCategories}, but with mode-resolved
 * tool variants: openai mode gets openai-specific implementations (async execution,
 * widget metadata), default mode gets standard implementations.
 *
 * This eliminates the need for runtime adapter dispatch — each tool is the correct
 * variant for its mode from the start.
 */
export function buildCategories(uiMode?: UiMode): ToolCategoryMap {
    const isOpenai = uiMode === 'openai';
    return {
        experimental: [
            addTool,
        ],
        actors: isOpenai
            ? [openaiSearchActors, openaiFetchActorDetails, openaiCallActor]
            : [defaultSearchActors, defaultFetchActorDetails, defaultCallActor],
        ui: isOpenai
            ? [searchActorsInternalTool, fetchActorDetailsInternalTool]
            : [],
        docs: [
            searchApifyDocsTool,
            fetchApifyDocsTool,
        ],
        runs: [
            isOpenai ? openaiGetActorRun : defaultGetActorRun,
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
    };
}

export const toolCategoriesEnabledByDefault: (typeof CATEGORY_NAMES)[number][] = [
    'actors',
    'docs',
];
