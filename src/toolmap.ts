// This module was created to prevent circular import dependency issues
import { HelperTools } from './const.js';
import { helpTool } from './tools/helpers.js';
import { actorDefinitionTool, addTool, removeTool } from './tools/index.js';
import { searchActorTool } from './tools/store_collection.js';
import type { ToolWrap } from './types.js';

export const internalToolsMap: Map<string, ToolWrap> = new Map([
    [HelperTools.SEARCH_ACTORS.toString(), searchActorTool],
    [HelperTools.ADD_ACTOR.toString(), addTool],
    [HelperTools.REMOVE_ACTOR.toString(), removeTool],
    [HelperTools.GET_ACTOR_DETAILS.toString(), actorDefinitionTool],
    [HelperTools.HELP_TOOL.toString(), helpTool],
]);
