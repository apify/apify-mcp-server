// Import specific tools that are being used
import { callActorGetDataset, getActor, getActorsAsTools } from './actor.js';
import { actorDefinitionTool } from './build.js';
import { addTool, helpTool, removeTool } from './helpers.js';
import { getUserRunsList } from './run_collection.js';
import { searchActors } from './store_collection.js';

export const defaultTools = [
    actorDefinitionTool,
    getActor,
    getUserRunsList,
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
