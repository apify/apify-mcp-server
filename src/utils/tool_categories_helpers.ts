/**
 * Helper functions for working with tool categories.
 * Separated from tools.ts to break circular dependency: tools/index.ts → utils/tools.ts → tools/categories.ts → tools/index.ts
 */
import { getCategoryTools } from '../tools/categories.js';
import type { ServerMode, ToolCategory, ToolEntry } from '../types.js';

/**
 * Returns the tool objects for the given category names resolved for the specified mode.
 */
export function getExpectedToolsByCategories(categories: ToolCategory[], mode: ServerMode): ToolEntry[] {
    const resolved = getCategoryTools(mode);
    return categories
        .flatMap((category) => resolved[category] || []);
}

/**
 * Returns the tool names for the given category names.
 * Tool names are identical across all server modes, so no mode parameter is needed.
 */
export function getExpectedToolNamesByCategories(categories: ToolCategory[]): string[] {
    return getExpectedToolsByCategories(categories, 'default').map((tool) => tool.name);
}
