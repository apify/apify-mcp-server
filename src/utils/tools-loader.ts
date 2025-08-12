/**
 * Shared logic for loading tools based on Input type.
 * This eliminates duplication between stdio.ts and processParamsGetTools.
 */

import { defaults } from '../const.js';
import { addRemoveTools, getActorsAsTools, toolCategories, toolCategoriesEnabledByDefault } from '../tools/index.js';
import type { Input, ToolCategory, ToolEntry } from '../types.js';
import { getExpectedToolsByCategories } from './tools.js';

/**
 * Load tools based on the provided Input object.
 * This function is used by both the stdio.ts and the processParamsGetTools function.
 *
 * @param input The processed Input object
 * @param apifyToken The Apify API token
 * @returns An array of tool entries
 */
export async function loadToolsFromInput(
    input: Input,
    apifyToken: string,
): Promise<ToolEntry[]> {
    let tools: ToolEntry[] = [];

    // Load actors as tools
    if (input.actors !== undefined) {
        const actors = Array.isArray(input.actors) ? input.actors : [input.actors];
        tools = await getActorsAsTools(actors, apifyToken);
    } else {
        // Use default actors if no actors are specified
        tools = await getActorsAsTools(defaults.actors, apifyToken);
    }

    // Add tools for adding/removing actors if enabled
    if (input.enableAddingActors) {
        tools.push(...addRemoveTools);
    }

    // Add tools from enabled categories
    if (input.tools !== undefined) {
        const toolKeys = Array.isArray(input.tools) ? input.tools : [input.tools];
        for (const toolKey of toolKeys) {
            const keyTools = toolCategories[toolKey as ToolCategory] || [];
            tools.push(...keyTools);
        }
    } else {
        tools.push(...getExpectedToolsByCategories(toolCategoriesEnabledByDefault));
    }

    return tools;
}
