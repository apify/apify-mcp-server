import { toolCategories } from '../tools/index.js';
import type { ToolBase, ToolCategory, ToolEntry } from '../types.js';

/**
 * Returns a public version of the tool containing only fields that should be exposed publicly.
 * Used for the tools list request.
 */
export function getToolPublicFieldOnly(tool: ToolBase) {
    return {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
    };
}

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
    return getExpectedToolsByCategories(categories).map((tool) => tool.tool.name);
}
