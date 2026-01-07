import { HelperTools } from '../const.js';
import type { ToolCategory } from '../types.js';
import { getExpectedToolsByCategories } from '../utils/tool-categories-helpers.js';
import { callActorGetDataset, getActorsAsTools } from './actor.js';
import { toolCategories, toolCategoriesEnabledByDefault } from './categories.js';

// Use string constants instead of importing tool objects to avoid circular dependency
export const unauthEnabledTools: string[] = [
    HelperTools.DOCS_SEARCH,
    HelperTools.DOCS_FETCH,
];

// Re-export from categories.ts
// This is actually needed to avoid circular dependency issues
export { toolCategories, toolCategoriesEnabledByDefault };

// Computed here (not in helper file) to avoid module initialization issues
export const defaultTools = getExpectedToolsByCategories(toolCategoriesEnabledByDefault);

/**
 * Returns the list of tool categories that are enabled for unauthenticated users.
 * A category is included only if all tools in it are in the unauthEnabledTools list.
 */
export function getUnauthEnabledToolCategories(): ToolCategory[] {
    const unauthEnabledToolsSet = new Set(unauthEnabledTools);
    return (Object.entries(toolCategories) as [ToolCategory, typeof toolCategories[ToolCategory]][])
        .filter(([, tools]) => tools.every((tool) => unauthEnabledToolsSet.has(tool.name)))
        .map(([category]) => category);
}

// Export actor-related tools
export { callActorGetDataset, getActorsAsTools };
