/*
 * Actor input processing.
 */
import log from '@apify/log';

import type { Input, ToolCategory } from './types.js';

/**
 * Process input parameters, split Actors string into an array
 * @param originalInput
 * @returns input
 */
export function processInput(originalInput: Partial<Input>): Input {
    const input = originalInput as Input;

    // actors can be a string or an array of strings
    if (input.actors && typeof input.actors === 'string') {
        input.actors = input.actors.split(',').map((format: string) => format.trim()) as string[];
    }

    // enableAddingActors is deprecated, use enableActorAutoLoading instead
    if (input.enableAddingActors === undefined) {
        if (input.enableActorAutoLoading !== undefined) {
            log.warning('enableActorAutoLoading is deprecated, use enableAddingActors instead');
            input.enableAddingActors = input.enableActorAutoLoading === true || input.enableActorAutoLoading === 'true';
        } else {
            input.enableAddingActors = true;
        }
    } else {
        input.enableAddingActors = input.enableAddingActors === true || input.enableAddingActors === 'true';
    }

    if (input.tools && typeof input.tools === 'string') {
        input.tools = input.tools.split(',').map((tool: string) => tool.trim()) as ToolCategory[];
    }
    return input;
}
