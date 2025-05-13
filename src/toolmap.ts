// This module was created to prevent circular import dependency issues
import { HelperTools } from './const.js';
import { helpTool } from './tools/helpers.js';
import { actorDefinitionTool, addTool, removeTool } from './tools/index.js';
import { searchActorTool } from './tools/store_collection.js';

export const internalToolsMap = {
    [HelperTools.SEARCH_ACTORS]: searchActorTool,
    [HelperTools.ADD_ACTOR]: addTool,
    [HelperTools.REMOVE_ACTOR]: removeTool,
    [HelperTools.GET_ACTOR_DETAILS]: actorDefinitionTool,
    [HelperTools.HELP_TOOL]: helpTool,
};
