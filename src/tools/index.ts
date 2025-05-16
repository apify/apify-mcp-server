// Import specific tools that are being used
import { callActorGetDataset, getActor, getActorsAsTools } from './actor.js';
import { actorDefinitionTool } from './build.js';
import { getDataset, getDatasetItems } from './dataset.js';
import { getUserDatasetsList } from './dataset_collection.js';
import { addTool, helpTool, removeTool } from './helpers.js';
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
    getUserRunsList,
    getUserDatasetsList,
    helpTool,
    searchActors,
];

// Export only the tools that are being used
export {
    addTool,
    removeTool,
    getActorsAsTools,
    callActorGetDataset,
};
