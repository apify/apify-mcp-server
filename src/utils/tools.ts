import type { ToolBase } from '../types.js';

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
