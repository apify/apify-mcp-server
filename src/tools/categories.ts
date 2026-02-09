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
import type { ToolCategory } from '../types.js';
import { callActor } from './actor.js';
import { getDataset, getDatasetItems, getDatasetSchema } from './dataset.js';
import { getUserDatasetsList } from './dataset_collection.js';
import { fetchActorDetailsTool } from './fetch-actor-details.js';
import { fetchActorDetailsInternalTool } from './fetch-actor-details-internal.js';
import { fetchApifyDocsTool } from './fetch-apify-docs.js';
import { getActorOutput } from './get-actor-output.js';
import { getHtmlSkeleton } from './get-html-skeleton.js';
import { addTool } from './helpers.js';
import { getKeyValueStore, getKeyValueStoreKeys, getKeyValueStoreRecord } from './key_value_store.js';
import { getUserKeyValueStoresList } from './key_value_store_collection.js';
import { abortActorRun, getActorRun, getActorRunLog } from './run.js';
import { getUserRunsList } from './run_collection.js';
import { searchActorsInternalTool } from './search-actors-internal.js';
import { searchApifyDocsTool } from './search-apify-docs.js';
import { searchActors } from './store_collection.js';

export const toolCategories = {
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

export const toolCategoriesEnabledByDefault: ToolCategory[] = [
    'actors',
    'docs',
];
