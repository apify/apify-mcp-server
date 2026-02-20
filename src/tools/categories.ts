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
import { fetchActorDetailsTool } from './fetch-actor-details.js';
import { fetchActorDetailsInternalTool } from './openai/fetch-actor-details-internal.js';
import { searchActorsInternalTool } from './openai/search-actors-internal.js';
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
