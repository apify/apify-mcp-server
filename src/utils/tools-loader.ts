/**
 * Shared logic for loading tools based on Input type.
 * This eliminates duplication between stdio.ts and processParamsGetTools.
 */

import { defaults } from '../const.js';
import { addTool } from '../tools/helpers.js';
import { getActorsAsTools, toolCategories, toolCategoriesEnabledByDefault } from '../tools/index.js';
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

    // Prepare lists for actor and internal tool/category selectors from `tools`
    let toolSelectors: (string | ToolCategory)[] | undefined;
    if (input.tools === undefined) {
        toolSelectors = undefined;
    } else if (Array.isArray(input.tools)) {
        toolSelectors = input.tools.filter((s) => String(s).trim() !== '');
    } else {
        toolSelectors = [input.tools].filter((s) => String(s).trim() !== '');
    }

    // Build a name -> tool entry map for all known internal (category) tools
    const allCategoryTools: ToolEntry[] = getExpectedToolsByCategories(Object.keys(toolCategories) as ToolCategory[]);
    const toolNameMap = new Map<string, ToolEntry>();
    for (const entry of allCategoryTools) {
        toolNameMap.set(entry.tool.name, entry);
    }

    // Classify selectors from `tools` into categories/internal tools and actor names
    const internalCategoryEntries: ToolEntry[] = [];
    const actorSelectorsFromTools: string[] = [];
    if (toolSelectors !== undefined) {
        for (const selector of toolSelectors) {
            const categoryTools = toolCategories[selector as ToolCategory];
            if (categoryTools && Array.isArray(categoryTools)) {
                internalCategoryEntries.push(...categoryTools);
                continue;
            }
            const internalByName = toolNameMap.get(String(selector));
            if (internalByName) {
                internalCategoryEntries.push(internalByName);
                continue;
            }
            // Treat unknown selectors as Actor IDs/full names
            actorSelectorsFromTools.push(String(selector));
        }
    }

    // Resolve actor list to load
    let actorsFromInputField: string[] | undefined;
    if (input.actors === undefined) {
        actorsFromInputField = undefined; // use defaults later unless overridden by tools
    } else if (Array.isArray(input.actors)) {
        actorsFromInputField = input.actors;
    } else {
        actorsFromInputField = [input.actors];
    }

    let actorNamesToLoad: string[] = [];
    if (actorsFromInputField !== undefined) {
        actorNamesToLoad = actorsFromInputField;
    } else if (actorSelectorsFromTools.length > 0) {
        // If no explicit `actors` were provided, but `tools` includes actor names,
        // load exactly those instead of defaults
        actorNamesToLoad = actorSelectorsFromTools;
    } else {
        // Use default actors if nothing specified anywhere
        actorNamesToLoad = defaults.actors;
    }

    // If both fields specify actors, merge them
    if (actorsFromInputField !== undefined && actorSelectorsFromTools.length > 0) {
        const merged = new Set<string>([...actorNamesToLoad, ...actorSelectorsFromTools]);
        actorNamesToLoad = Array.from(merged);
    }

    // Load actor tools (if any)
    if (actorNamesToLoad.length > 0) {
        tools = await getActorsAsTools(actorNamesToLoad, apifyToken);
    }

    // Add tool for dynamically adding actors if enabled
    if (input.enableAddingActors) {
        tools.push(addTool);
    }

    // Add internal tools from categories/tool names or defaults when `tools` unspecified
    if (toolSelectors !== undefined) {
        // Respect disable flag: do not include add-actor even if explicitly requested
        const filteredInternal = input.enableAddingActors
            ? internalCategoryEntries
            : internalCategoryEntries.filter((entry) => entry.tool.name !== addTool.tool.name);
        tools.push(...filteredInternal);
    } else {
        tools.push(...getExpectedToolsByCategories(toolCategoriesEnabledByDefault));
    }

    // De-duplicate by tool name
    const seen = new Set<string>();
    tools = tools.filter((entry) => {
        const { name } = entry.tool;
        if (seen.has(name)) return false;
        seen.add(name);
        return true;
    });

    return tools;
}
