import { HELPER_TOOLS } from '../const.js';
import type { ToolCategory, ToolEntry } from '../types.js';
import { SERVER_MODE } from '../types.js';
import { getExpectedToolsByCategories } from '../utils/tool_categories_helpers.js';
import { getActorsAsTools } from './actors/actor_tools_factory.js';
import type { ActorsAsToolsResult } from './actors/actor_tools_factory.js';
import {
    CATEGORY_NAME_SET,
    CATEGORY_NAMES,
    getCategoryTools,
    toolCategories,
    toolCategoriesEnabledByDefault,
} from './registry.js';

// Use string constants instead of tool object imports to avoid circular dependencies
export const unauthEnabledTools: string[] = [
    HELPER_TOOLS.DOCS_SEARCH,
    HELPER_TOOLS.DOCS_FETCH,
    HELPER_TOOLS.STORE_SEARCH,
    HELPER_TOOLS.ACTOR_GET_DETAILS,
];

// Re-export from registry.ts
// This is actually needed to avoid circular dependency issues
export { CATEGORY_NAME_SET, CATEGORY_NAMES, getCategoryTools, toolCategories, toolCategoriesEnabledByDefault };

/**
 * Returns the tool entries for the default-enabled categories resolved for the given mode.
 * Computed here (not in helper file) to avoid module initialization issues.
 */
export function getDefaultTools(mode: SERVER_MODE = SERVER_MODE.DEFAULT): ToolEntry[] {
    return getExpectedToolsByCategories(toolCategoriesEnabledByDefault, mode);
}

/**
 * Returns the list of tool categories that are enabled for unauthenticated users.
 * A category is included only if all tools in it are in the unauthEnabledTools list.
 * Tool names are identical across all server modes, so no mode parameter is needed.
 */
export function getUnauthEnabledToolCategories(): ToolCategory[] {
    const unauthEnabledToolsSet = new Set(unauthEnabledTools);
    const categories = getCategoryTools(SERVER_MODE.DEFAULT);
    return (Object.entries(categories) as [ToolCategory, ToolEntry[]][])
        .filter(([, tools]) => tools.every((tool) => unauthEnabledToolsSet.has(tool.name)))
        .map(([category]) => category);
}

// Export actor-related tools
export { getActorsAsTools };
export type { ActorsAsToolsResult };
