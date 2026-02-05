/**
 * Tool categories and their associated tools.
 * This file is separate from index.ts to avoid circular dependencies.
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

// Tool categories with tools ordered by typical workflow:
// 1. Search/discover → 2. Get details → 3. Execute → 4. Check status → 5. Get results
export const toolCategories = {
    experimental: [
        addTool,
    ],
    actors: [
        searchActors,           // 1. Search for actors
        fetchActorDetailsTool,  // 2. Get details about an actor
        callActor,              // 3. Run the actor
    ],
    ui: [
        searchActorsInternalTool,
        fetchActorDetailsInternalTool,
    ],
    runs: [
        getActorRun,            // 4. Check run status
        getActorRunLog,         // 5. Get run logs
        getUserRunsList,        // 6. List all runs
        abortActorRun,          // 7. Abort if needed
    ],
    storage: [
        getActorOutput,         // 8. Get output (most common)
        getDataset,
        getDatasetItems,
        getDatasetSchema,
        getKeyValueStore,
        getKeyValueStoreKeys,
        getKeyValueStoreRecord,
        getUserDatasetsList,
        getUserKeyValueStoresList,
    ],
    docs: [
        searchApifyDocsTool,    // Search docs
        fetchApifyDocsTool,     // Fetch specific doc
    ],
    dev: [
        getHtmlSkeleton,
    ],
};

export const toolCategoriesEnabledByDefault: ToolCategory[] = [
    'actors',
    'docs',
];
