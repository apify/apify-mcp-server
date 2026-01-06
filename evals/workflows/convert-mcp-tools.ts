/**
 * Convert MCP tool definitions to OpenAI tool format
 */

import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import type { McpTool } from './types.js';

/**
 * Convert MCP tools to OpenAI tools format
 * 
 * MCP uses JSON Schema directly, OpenAI uses a similar but wrapped format.
 * This function converts MCP tool definitions to OpenAI's expected format.
 */
export function mcpToolsToOpenAiTools(mcpTools: McpTool[]): ChatCompletionTool[] {
    return mcpTools.map(tool => ({
        type: 'function' as const,
        function: {
            name: tool.name,
            description: tool.description || '',
            parameters: tool.inputSchema,
        },
    }));
}
