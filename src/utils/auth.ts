import { CATEGORY_NAME_SET, getUnauthEnabledToolCategories, unauthEnabledTools } from '../tools/index.js';
import type { ToolCategory } from '../types.js';

/**
 * Determines if an API token is required based on requested tools and actors.
 * Tool names and category membership are identical across all server modes,
 * so no mode parameter is needed.
 */
export function isApiTokenRequired(params: {
    toolCategoryKeys?: string[];
    actorList?: string[];
    enableAddingActors?: boolean;
}): boolean {
    const { toolCategoryKeys, actorList, enableAddingActors } = params;

    // If no tools or categories specified, default to requiring token
    // (This matches current requirement for full server start)
    if (!toolCategoryKeys || toolCategoryKeys.length === 0) {
        return true;
    }

    const unauthTokenSet = new Set(unauthEnabledTools);
    // Convert ToolCategory[] to Set<string> for comparison with string keys
    const unauthCategorySet = new Set<string>(getUnauthEnabledToolCategories() as ToolCategory[]);

    const areAllToolsSafe = toolCategoryKeys.every((key) => {
        // If it is a safe category
        if (unauthCategorySet.has(key)) return true;
        // If it is a safe tool
        if (unauthTokenSet.has(key)) return true;

        // If it is a known category but not safe -> unsafe
        if (CATEGORY_NAME_SET.has(key)) return false;

        // Otherwise it is likely an Actor name -> unsafe
        return false;
    });

    const isActorsEmpty = !actorList || actorList.length === 0;

    // Only bypass token if all requested tools are public AND no specific actors requested
    // AND adding actors at runtime is disabled.
    if (areAllToolsSafe && isActorsEmpty && !enableAddingActors) {
        return false;
    }

    return true;
}
