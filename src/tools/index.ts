// Import specific tools that are being used
import type { ToolCategory } from '../types.js';
import { callActor, callActorGetDataset, getActorsAsTools } from './actor.js';
import { getDataset, getDatasetItems } from './dataset.js';
import { getUserDatasetsList } from './dataset_collection.js';
import { fetchApifyDocsTool } from './fetch-apify-docs.js';
import { getActorDetailsTool } from './get-actor-details.js';
import { addTool } from './helpers.js';
import { getKeyValueStore, getKeyValueStoreKeys, getKeyValueStoreRecord } from './key_value_store.js';
import { getUserKeyValueStoresList } from './key_value_store_collection.js';
import { getActorRun, getActorRunLog } from './run.js';
import { getUserRunsList } from './run_collection.js';
import { searchApifyDocsTool } from './search-apify-docs.js';
import { searchActors } from './store_collection.js';

export const toolCategories = {
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
        getKeyValueStore,
        getKeyValueStoreKeys,
        getKeyValueStoreRecord,
        getUserDatasetsList,
        getUserKeyValueStoresList,
    ],
    preview: [
        callActor,
    ],
};
export const toolCategoriesEnabledByDefault: ToolCategory[] = [
    'docs',
];

export const defaultTools = [
    getActorDetailsTool,
    searchActors,
    // Add the tools from the enabled categories
    ...toolCategoriesEnabledByDefault.map((key) => toolCategories[key]).flat(),
];

export const addRemoveTools = [
    addTool,
];

// Export only the tools that are being used
export {
    getActorsAsTools,
    callActorGetDataset,
};
