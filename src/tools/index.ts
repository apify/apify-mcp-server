// Import specific tools that are being used
import { callActorGetDataset, getActorsAsTools } from './actor.js';
import { fetchApifyDocsTool } from './fetch-apify-docs.js';
import { getActorDetailsTool } from './get-actor-details.js';
import { addTool, helpTool } from './helpers.js';
import { searchApifyDocsTool } from './search-apify-docs.js';
import { searchActors } from './store_collection.js';

export const defaultTools = [
    // abortActorRun,
    // actorDetailsTool,
    // getActor,
    // getActorLog,
    // getActorRun,
    // getDataset,
    // getDatasetItems,
    // getKeyValueStore,
    // getKeyValueStoreKeys,
    // getKeyValueStoreRecord,
    // getUserRunsList,
    // getUserDatasetsList,
    // getUserKeyValueStoresList,
    getActorDetailsTool,
    helpTool,
    searchActors,
    searchApifyDocsTool,
    fetchApifyDocsTool,
];

export const addRemoveTools = [
    addTool,
    // removeTool,
];

// Export only the tools that are being used
export {
    addTool,
    // removeTool,
    getActorsAsTools,
    callActorGetDataset,
};
