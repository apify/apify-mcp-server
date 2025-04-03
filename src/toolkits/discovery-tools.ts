import { discoverActorsTool } from '../tools/discover-actors.js';
import { getActorsDetailsTool } from '../tools/get-actors-details.js';
import type { ToolWrap } from '../types.js';

export function getActorDiscoveryTools(): ToolWrap[] {
    return [
        discoverActorsTool,
        getActorsDetailsTool,
    ];
}
