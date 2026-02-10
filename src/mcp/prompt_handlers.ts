import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ErrorCode, GetPromptRequestSchema, ListPromptsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';

import { prompts } from '../prompts/index.js';

type RegisterPromptHandlersParams = {
    server: Server;
};

/**
 * Registers MCP prompt handlers.
 */
export function registerPromptHandlers({ server }: RegisterPromptHandlersParams): void {
    /**
     * Handles the prompts/list request.
     */
    server.setRequestHandler(ListPromptsRequestSchema, () => {
        return { prompts };
    });

    /**
     * Handles the prompts/get request.
     */
    server.setRequestHandler(GetPromptRequestSchema, (request) => {
        const { name, arguments: args } = request.params;
        const prompt = prompts.find((p) => p.name === name);
        if (!prompt) {
            throw new McpError(
                ErrorCode.InvalidParams,
                `Prompt ${name} not found. Available prompts: ${prompts.map((p) => p.name).join(', ')}`,
            );
        }
        if (!prompt.ajvValidate(args)) {
            throw new McpError(
                ErrorCode.InvalidParams,
                `Invalid arguments for prompt ${name}: args: ${JSON.stringify(args)} error: ${JSON.stringify(prompt.ajvValidate.errors)}`,
            );
        }
        return {
            description: prompt.description,
            messages: [
                {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: prompt.render(args || {}),
                    },
                },
            ],
        };
    });
}
