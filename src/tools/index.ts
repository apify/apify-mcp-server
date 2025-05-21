// Import specific tools that are being used
import { callActorGetDataset, getActor, getActorsAsTools } from './actor.js';
import { actorDefinitionTool } from './build.js';
import { getDataset, getDatasetItems } from './dataset.js';
import { getUserDatasetsList } from './dataset_collection.js';
import { addTool, helpTool, removeTool } from './helpers.js';
import { getKeyValueStore, getKeyValueStoreKeys, getKeyValueStoreRecord } from './key_value_store.js';
import { getUserKeyValueStoresList } from './key_value_store_collection.js';
import { abortActorRun, getActorLog, getActorRun } from './run.js';
import { getUserRunsList } from './run_collection.js';
import { searchActors } from './store_collection.js';

export const defaultTools = [
    abortActorRun,
    actorDefinitionTool,
    getActor,
    getActorLog,
    getActorRun,
    getDataset,
    getDatasetItems,
    getKeyValueStore,
    getKeyValueStoreKeys,
    getKeyValueStoreRecord,
    getUserRunsList,
    getUserDatasetsList,
    getUserKeyValueStoresList,
    helpTool,
    searchActors,
];

export const addRemoveTools = [
    addTool,
    removeTool,
];

// Export only the tools that are being used
export {
    addTool,
    removeTool,
    getActorsAsTools,
    callActorGetDataset,
};
