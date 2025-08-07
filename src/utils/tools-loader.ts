/**
 * Shared logic for loading tools based on Input type.
 * This eliminates duplication between stdio.ts and processParamsGetTools.
 */

import { defaults } from '../const.js';
import { addRemoveTools, getActorsAsTools, toolCategories } from '../tools/index.js';
import type { McpOptions } from '../input.js';
import type { ToolCategory, ToolEntry } from '../types.js';

/**
 * Load tools based on the provided Input object.
 * This function is used by both the stdio.ts and the processParamsGetTools function.
 *
 * @param input The processed Input object
 * @param apifyToken The Apify API token
 * @param useDefaultActors Whether to use default actors if no actors are specified
 * @returns An array of tool entries
 */
export async function loadToolsFromInput(
    input: McpOptions,
    apifyToken: string,
    useDefaultActors = false,
): Promise<ToolEntry[]> {
    let tools: ToolEntry[] = [];

    // Load actors as tools
    if (input.actors && (Array.isArray(input.actors) ? input.actors.length > 0 : input.actors)) {
        const actors = Array.isArray(input.actors) ? input.actors : [input.actors];
        tools = await getActorsAsTools(actors, apifyToken, input.fullActorSchema);
    } else if (useDefaultActors) {
        // Use default actors if no actors are specified and useDefaultActors is true
        tools = await getActorsAsTools(defaults.actors, apifyToken, input.fullActorSchema);
    }

    // Add tools for adding/removing actors if enabled
    if (input.enableAddingActors) {
        tools.push(...addRemoveTools);
    }

    // Add tools from enabled categories
    if (input.tools) {
        const toolKeys = Array.isArray(input.tools) ? input.tools : [input.tools];
        for (const toolKey of toolKeys) {
            const keyTools = toolCategories[toolKey as ToolCategory] || [];
            tools.push(...keyTools);
        }
    }

    return tools;
}
