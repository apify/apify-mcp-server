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

    // enableActorAutoLoading is deprecated, use enableAddingActors instead
    if (input.enableAddingActors === undefined) {
        if (input.enableActorAutoLoading !== undefined) {
            log.warning('enableActorAutoLoading is deprecated, use enableAddingActors instead');
            input.enableAddingActors = input.enableActorAutoLoading === true || input.enableActorAutoLoading === 'true';
        } else {
            // Default: do NOT enable add-actor unless explicitly requested
            input.enableAddingActors = false;
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

    // Merge actors into tools selectors so that specifying only actors disables
    // default internal tools/categories. If tools are not provided, treat actors
    // as the only tool selectors. If tools are provided, append actors to tools.
    if (Array.isArray(input.actors) && input.actors.length > 0) {
        if (input.tools === undefined) {
            input.tools = [...input.actors] as ToolSelector[];
            // Treat as if only tools were specified; clear actors to avoid duplicate semantics
            input.actors = undefined as unknown as string[];
        } else {
            const currentTools: ToolSelector[] = Array.isArray(input.tools)
                ? input.tools
                : [input.tools as ToolSelector];
            input.tools = [...currentTools, ...input.actors] as ToolSelector[];
        }
    }
    return input;
}
