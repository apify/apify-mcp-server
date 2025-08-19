/*
 * Actor input processing.
 */
import log from '@apify/log';

import type { Input, ToolSelector } from './types.js';

/**
 * Process input parameters, split Actors string into an array
 * @param originalInput
 * @returns input
 */
export function processInput(originalInput: Partial<Input>): Input {
    const input = originalInput as Input;

    // actors can be a string or an array of strings
    if (input.actors && typeof input.actors === 'string') {
        /**
         * Filter out empty strings to prevent invalid Actor API error.
         */
        input.actors = input.actors.split(',').map((format: string) => format.trim()).filter((actor) => actor !== '') as string[];
    }
    /**
     * Replace empty string with empty array to prevent invalid Actor API error.
     */
    if (input.actors === '') {
        input.actors = [];
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
        /**
         * Filter out empty strings just in case.
         */
        input.tools = input.tools.split(',').map((tool: string) => tool.trim()).filter((tool) => tool !== '') as ToolSelector[];
    }
    // Normalize explicit empty string to empty array (signals no internal tools)
    if (input.tools === '') {
        input.tools = [] as unknown as ToolSelector[];
    }

    // Backward compatibility: if tools is explicitly specified, merge also actors into tools selectors
    // This keeps previous semantics when tools is undefined (defaults categories apply).
    if (input.tools !== undefined && Array.isArray(input.actors) && input.actors.length > 0) {
        let currentTools: ToolSelector[] = [];
        if (input.tools !== undefined) {
            currentTools = Array.isArray(input.tools) ? input.tools : [input.tools as ToolSelector];
        }
        input.tools = [...currentTools, ...input.actors] as ToolSelector[];
    }
    return input;
}
