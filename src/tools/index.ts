// Import specific tools that are being used
import type { ToolCategory } from '../types.js';
import { getExpectedToolsByCategories } from '../utils/tools.js';
import { callActor, callActorGetDataset, getActorsAsTools } from './actor.js';
import { getDataset, getDatasetItems, getDatasetSchema } from './dataset.js';
import { getUserDatasetsList } from './dataset_collection.js';
import { fetchActorDetailsTool } from './fetch-actor-details.js';
import { fetchApifyDocsTool } from './fetch-apify-docs.js';
import { getActorOutput } from './get-actor-output.js';
import { addTool } from './helpers.js';
import { getKeyValueStore, getKeyValueStoreKeys, getKeyValueStoreRecord } from './key_value_store.js';
import { getUserKeyValueStoresList } from './key_value_store_collection.js';
import { getActorRun, getActorRunLog } from './run.js';
import { getUserRunsList } from './run_collection.js';
import { searchApifyDocsTool } from './search-apify-docs.js';
import { searchActors } from './store_collection.js';

export const toolCategories = {
    experimental: [
        addTool,
    ],
    actors: [
        fetchActorDetailsTool,
        searchActors,
        callActor,
    ],
    docs: [
        searchApifyDocsTool,
        fetchApifyDocsTool,
    ],
    runs: [
        getActorRun,
        getUserRunsList,
        getActorRunLog,
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
};
export const toolCategoriesEnabledByDefault: ToolCategory[] = [
    'actors',
    'docs',
];

export const defaultTools = getExpectedToolsByCategories(toolCategoriesEnabledByDefault);

// Export only the tools that are being used
export {
    getActorsAsTools,
    callActorGetDataset,
};
