/**
 * Shared logic for loading tools based on Input type.
 * This eliminates duplication between stdio.ts and processParamsGetTools.
 */

import { defaults } from '../const.js';
import { addTool } from '../tools/helpers.js';
import { getActorsAsTools, toolCategories, toolCategoriesEnabledByDefault } from '../tools/index.js';
import type { AuthToken, Input, ToolCategory, ToolEntry } from '../types.js';
import { getExpectedToolsByCategories } from './tools.js';

// Lazily-computed cache of internal tools by name to avoid circular init issues.
let INTERNAL_TOOL_BY_NAME_CACHE: Map<string, ToolEntry> | null = null;
function getInternalToolByNameMap(): Map<string, ToolEntry> {
    if (!INTERNAL_TOOL_BY_NAME_CACHE) {
        const allInternal = getExpectedToolsByCategories(Object.keys(toolCategories) as ToolCategory[]);
        INTERNAL_TOOL_BY_NAME_CACHE = new Map<string, ToolEntry>(
            allInternal.map((entry) => [entry.tool.name, entry]),
        );
    }
    return INTERNAL_TOOL_BY_NAME_CACHE;
}

/**
 * Load tools based on the provided Input object.
 * This function is used by both the stdio.ts and the processParamsGetTools function.
 *
 * @param input The processed Input object
 * @param authToken The authentication token
 * @returns An array of tool entries
 */
export async function loadToolsFromInput(
    input: Input,
    authToken: AuthToken,
): Promise<ToolEntry[]> {
    // Helpers for readability
    const normalizeSelectors = (value: Input['tools']): (string | ToolCategory)[] | undefined => {
        if (value === undefined) return undefined;
        return (Array.isArray(value) ? value : [value]).map(String).map((s) => s.trim()).filter((s) => s !== '');
    };

    const selectors = normalizeSelectors(input.tools);
    const selectorsProvided = selectors !== undefined;
    const selectorsExplicitEmpty = selectorsProvided && (selectors as string[]).length === 0;
    const addActorEnabled = input.enableAddingActors === true;
    const actorsExplicitlyEmpty = (Array.isArray(input.actors) && input.actors.length === 0) || input.actors === '';

    // Partition selectors into internal picks (by category or by name) and actor names
    const internalSelections: ToolEntry[] = [];
    const actorSelectorsFromTools: string[] = [];
    if (selectorsProvided && !selectorsExplicitEmpty) {
        for (const selector of selectors as (string | ToolCategory)[]) {
            const categoryTools = toolCategories[selector as ToolCategory];
            if (categoryTools) {
                internalSelections.push(...categoryTools);
                continue;
            }
            const internalByName = getInternalToolByNameMap().get(String(selector));
            if (internalByName) {
                internalSelections.push(internalByName);
                continue;
            }
            // Treat unknown selectors as Actor IDs/full names.
            // Potential heuristic (future): if (String(selector).includes('/')) => definitely an Actor.
            actorSelectorsFromTools.push(String(selector));
        }
    }

    // Decide which Actors to load
    let actorsFromField: string[] | undefined;
    if (input.actors === undefined) {
        actorsFromField = undefined;
    } else if (Array.isArray(input.actors)) {
        actorsFromField = input.actors;
    } else {
        actorsFromField = [input.actors];
    }

    let actorNamesToLoad: string[] = [];
    if (actorsFromField !== undefined) {
        actorNamesToLoad = actorsFromField;
    } else if (actorSelectorsFromTools.length > 0) {
        actorNamesToLoad = actorSelectorsFromTools;
    } else if (!selectorsProvided) {
        // No selectors supplied: use defaults unless add-actor mode is enabled
        actorNamesToLoad = addActorEnabled ? [] : defaults.actors;
    } // else: selectors provided but none are actors => do not load defaults

    // Compose final tool list
    const result: ToolEntry[] = [];

    // Internal tools
    if (selectorsProvided) {
        result.push(...internalSelections);
        // If add-actor mode is enabled, ensure add-actor tool is available alongside selected tools.
        if (addActorEnabled && !selectorsExplicitEmpty && !actorsExplicitlyEmpty) {
            const hasAddActor = result.some((e) => e.tool.name === addTool.tool.name);
            if (!hasAddActor) result.push(addTool);
        }
    } else if (addActorEnabled && !actorsExplicitlyEmpty) {
        // No selectors: either expose only add-actor (when enabled), or default categories
        result.push(addTool);
    } else if (!actorsExplicitlyEmpty) {
        result.push(...getExpectedToolsByCategories(toolCategoriesEnabledByDefault));
    }

    // Actor tools (if any)
    if (actorNamesToLoad.length > 0) {
        const actorTools = await getActorsAsTools(actorNamesToLoad, authToken);
        result.push(...actorTools);
    }

    // De-duplicate by tool name for safety
    const seen = new Set<string>();
    const deduped = result.filter((entry) => {
        const { name } = entry.tool;
        if (seen.has(name)) return false;
        seen.add(name);
        return true;
    });

    return deduped;
}
