import { HelperTools } from '../const.js';
import type { ServerMode, ToolCategory, ToolEntry } from '../types.js';
import { getExpectedToolsByCategories } from '../utils/tool_categories_helpers.js';
import { CATEGORY_NAME_SET, CATEGORY_NAMES, getCategoryTools, toolCategories, toolCategoriesEnabledByDefault } from './categories.js';
import { callActorGetDataset } from './core/actor_execution.js';
import { getActorsAsTools } from './core/actor_tools_factory.js';

// Use string constants instead of importing tool objects to avoid circular dependency
export const unauthEnabledTools: string[] = [
    HelperTools.DOCS_SEARCH,
    HelperTools.DOCS_FETCH,
    HelperTools.STORE_SEARCH,
];

// Re-export from categories.ts
// This is actually needed to avoid circular dependency issues
export { CATEGORY_NAME_SET, CATEGORY_NAMES, getCategoryTools, toolCategories, toolCategoriesEnabledByDefault };

/**
 * Returns the tool entries for the default-enabled categories resolved for the given mode.
 * Computed here (not in helper file) to avoid module initialization issues.
 */
export function getDefaultTools(mode: ServerMode): ToolEntry[] {
    return getExpectedToolsByCategories(toolCategoriesEnabledByDefault, mode);
}

/**
 * Returns the list of tool categories that are enabled for unauthenticated users.
 * A category is included only if all tools in it are in the unauthEnabledTools list.
 * Tool names are identical across all server modes, so no mode parameter is needed.
 */
export function getUnauthEnabledToolCategories(): ToolCategory[] {
    const unauthEnabledToolsSet = new Set(unauthEnabledTools);
    const categories = getCategoryTools('default');
    return (Object.entries(categories) as [ToolCategory, ToolEntry[]][])
        .filter(([, tools]) => tools.every((tool) => unauthEnabledToolsSet.has(tool.name)))
        .map(([category]) => category);
}

// Export actor-related tools
export { callActorGetDataset, getActorsAsTools };
