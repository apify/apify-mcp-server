import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import { Agent } from '@mastra/core';
import { MCPClient } from '@mastra/mcp';
import type { GenerateTextResult, LanguageModelUsage } from 'ai';

export async function makeMCPRequest(userPrompt: string, model: string):
    Promise<GenerateTextResult<any, unknown> & { mcpCalls: { tool: string, args: any }[], usage: LanguageModelUsage }> {
    const mcpClient = new MCPClient({
        id: `mcp-client-${Math.random().toString(36).substring(2, 15)}`,
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

    const mcpAgent = new Agent({
        name: 'MCP Agent',
        instructions: 'You are agent to handle MCP tools',
        model: getLanguageModel(model),
    });

    const result = await mcpAgent.generate(userPrompt, {
        maxSteps: 10,
        toolsets,
    });

    await mcpClient.disconnect();

    const mcpCalls = result.steps.flatMap((step) => step.toolCalls).map((call) => ({
        tool: call.toolName,
        args: call.args,
    }));

    const usage = result.steps.reduce((sum, step) => ({
        totalTokens: sum.totalTokens + step.usage.totalTokens,
        promptTokens: sum.promptTokens + step.usage.promptTokens,
        completionTokens: sum.completionTokens + step.usage.completionTokens,
    }), { totalTokens: 0, promptTokens: 0, completionTokens: 0 });

    return { ...result, mcpCalls, usage };
}
function getLanguageModel(model: string) {
    if (model.startsWith('openai/')) {
        return openai(model.replace(/^openai\//, ''));
    }
    if (model.startsWith('anthropic/')) {
        return anthropic(model.replace(/^anthropic\//, ''));
    }
    throw new Error(`Unknown model provider for: ${model}`);
}
