import { toolCategories } from '../tools/index.js';
import type { InternalTool, ToolBase, ToolCategory, ToolEntry } from '../types.js';

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

/**
 * Creates a deep copy of a tool entry, preserving functions like ajvValidate and call
 * while cloning all other properties to avoid shared state mutations.
 */
export function cloneToolEntry(toolEntry: ToolEntry): ToolEntry {
    // Store the original functions
    const originalAjvValidate = toolEntry.tool.ajvValidate;
    const originalCall = toolEntry.type === 'internal' ? (toolEntry.tool as InternalTool).call : undefined;

    // Create a deep copy using JSON serialization (excluding functions)
    const cloned = JSON.parse(JSON.stringify(toolEntry, (key, value) => {
        if (key === 'ajvValidate' || key === 'call') return undefined;
        return value;
    })) as ToolEntry;

    // Restore the original functions
    cloned.tool.ajvValidate = originalAjvValidate;
    if (toolEntry.type === 'internal' && originalCall) {
        (cloned.tool as InternalTool).call = originalCall;
    }

    return cloned;
}
