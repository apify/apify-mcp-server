// Import specific tools that are being used
import { callActor, callActorGetDataset, getActorsAsTools } from './actor.js';
import { getActorDetailsTool } from './get-actor-details.js';
import { addTool, helpTool } from './helpers.js';
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
    callActor,
    getActorDetailsTool,
    helpTool,
    searchActors,
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
