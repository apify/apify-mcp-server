import type { ToolWrap } from '../types.js';
import { addActorToTools } from './add-actors-to-tools.js';
import { discoverActorsTool } from './discover-actors.js';
import { getActorsDetailsTool } from './get-actors-details.js';
import { removeActorFromTools } from './remove-actors-from-tools.js';

export { addActorToTools, removeActorFromTools, discoverActorsTool, getActorsDetailsTool };

export function getActorAutoLoadingTools(): ToolWrap[] {
    return [
        addActorToTools,
        removeActorFromTools,
    ];
}

export function getActorDiscoveryTools(): ToolWrap[] {
    return [
        discoverActorsTool,
        getActorsDetailsTool,
    ];
}
