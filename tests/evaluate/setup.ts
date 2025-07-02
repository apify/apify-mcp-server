import { openai } from '@ai-sdk/openai';
import { Agent } from '@mastra/core';
import { MCPClient } from '@mastra/mcp';
import type { GenerateTextResult } from 'ai';

export const mcpAgent = new Agent({
    name: 'Weather Agent',
    instructions: 'You are agent to handle MCP tools',
    model: openai('gpt-4o-mini'),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function makeMCPRequest(userPrompt: string): Promise<GenerateTextResult<any, unknown>> {
    const mcpClient = new MCPClient({
        servers: {
            apify: {
                url: new URL('https://mcp.apify.com/'),
                requestInit: {
                    headers: {
                        Authorization: `Bearer ${process.env.APIFY_TOKEN}`,
                    },
                },
            },
        },
    });

    const toolsets = await mcpClient.getToolsets();

    const result = await mcpAgent.generate(userPrompt, {
        maxSteps: 10,
        toolsets,
    });

    await mcpClient.disconnect();

    return result;
}
