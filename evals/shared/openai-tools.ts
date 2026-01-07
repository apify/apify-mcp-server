/**
 * Convert tool definitions to OpenAI format
 * Unified function for both MCP tools and internal ToolBase types
 */

import type OpenAI from 'openai';

import type { McpTool } from './types.js';

/**
 * Generic tool interface that matches both ToolBase and McpTool
 */
type GenericTool = {
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
}

/**
 * Convert tools to OpenAI Chat Completion format
 * Works with both MCP tools and ToolBase from the server
 */
export function transformToolsToOpenAIFormat(tools: GenericTool[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
    return tools.map((tool) => ({
        type: 'function' as const,
        function: {
            name: tool.name,
            description: tool.description || '',
            parameters: tool.inputSchema,
        },
    }));
}

/**
 * Alias for MCP-specific usage (keeps backwards compatibility)
 */
export function mcpToolsToOpenAiTools(mcpTools: McpTool[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
    return transformToolsToOpenAIFormat(mcpTools);
}
