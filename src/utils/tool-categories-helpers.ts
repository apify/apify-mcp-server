/**
 * Helper functions for working with tool categories.
 * Separated from tools.ts to break circular dependency: tools/index.ts → utils/tools.ts → tools/categories.ts → tools/index.ts
 */
import { toolCategories } from '../tools/categories.js';
import type { ToolCategory, ToolEntry } from '../types.js';

/**
 * Returns the tool objects for the given category names using toolCategories.
 */
export function getExpectedToolsByCategories(categories: ToolCategory[]): ToolEntry[] {
    return categories
        .flatMap((category) => toolCategories[category] || []);
}

/**
 * Returns the tool names for the given category names using getExpectedToolsByCategories.
 */
export function getExpectedToolNamesByCategories(categories: ToolCategory[]): string[] {
    return getExpectedToolsByCategories(categories).map((tool) => tool.name);
}
