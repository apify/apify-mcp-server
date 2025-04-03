import { addActorToTools } from '../tools/add-actors-to-tools.js';
import { removeActorFromTools } from '../tools/remove-actors-from-tools.js';
import type { ToolWrap } from '../types.js';

export function getActorAutoLoadingTools(): ToolWrap[] {
    return [
        addActorToTools,
        removeActorFromTools,
    ];
}
