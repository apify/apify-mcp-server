// Import specific tools that are being used
import type { ToolCategory } from '../types.js';
import { getExpectedToolsByCategories } from '../utils/tools.js';
import { callActor, callActorGetDataset, getActorsAsTools } from './actor.js';
import { getDataset, getDatasetItems, getDatasetSchema } from './dataset.js';
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
    'actor-discovery': [
        getActorDetailsTool,
        searchActors,
        /**
         * TODO: we should add the add-actor tool here but we would need to change the configuraton
         * interface around the ?enableAddingActors
         */
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
    'actor-discovery',
    'docs',
];

export const defaultTools = getExpectedToolsByCategories(toolCategoriesEnabledByDefault);

/**
 * Tools related to `enableAddingActors` param for dynamic Actor adding.
 */
export const addRemoveTools = [
    addTool,
];

// Export only the tools that are being used
export {
    getActorsAsTools,
    callActorGetDataset,
};
