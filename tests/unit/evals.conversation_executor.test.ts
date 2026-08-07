import { describe, expect, it } from 'vitest';

import { executeConversation } from '../../evals/workflows/conversation_executor.js';
import type { LlmClient, LlmResponse } from '../../evals/workflows/llm_client.js';
import type { McpClient } from '../../evals/workflows/mcp_client.js';
import type { McpToolResult } from '../../evals/workflows/types.js';

/** LLM client that replays a scripted list of responses, one per turn. */
function makeLlmClient(responses: LlmResponse[]): LlmClient {
    let turn = 0;
    return {
        callLlm: async (): Promise<LlmResponse> => {
            const response = responses[turn];
            turn += 1;
            if (!response) throw new Error('ran out of scripted LLM responses');
            return response;
        },
    } as unknown as LlmClient;
}

/** MCP client with no tools that returns a fixed result for every tool call. */
function makeMcpClient(toolResult: McpToolResult): McpClient {
    return {
        getTools: () => [],
        getInstructions: () => null,
        callTool: async (): Promise<McpToolResult> => ({ ...toolResult }),
    } as unknown as McpClient;
}

const toolCallResponse = (usage?: LlmResponse['usage']): LlmResponse => ({
    content: null,
    toolCalls: [{ id: 'call-1', name: 'search-actors', arguments: '{}' }],
    usage,
});

const finalResponse = (usage?: LlmResponse['usage']): LlmResponse => ({
    content: 'done',
    usage,
});

describe('executeConversation()', () => {
    it('accumulates token usage across multiple turns', async () => {
        const conversation = await executeConversation({
            userPrompt: 'go',
            mcpClient: makeMcpClient({ toolName: 'search-actors', success: true, result: { items: [] } }),
            llmClient: makeLlmClient([
                toolCallResponse({ promptTokens: 10, completionTokens: 5, totalTokens: 15 }),
                finalResponse({ promptTokens: 20, completionTokens: 7, totalTokens: 27 }),
            ]),
        });

        expect(conversation.promptTokens).toBe(30);
        expect(conversation.completionTokens).toBe(12);
        expect(conversation.totalTokens).toBe(42);
    });

    it('records resultBytes on a successful tool result', async () => {
        const conversation = await executeConversation({
            userPrompt: 'go',
            mcpClient: makeMcpClient({ toolName: 'search-actors', success: true, result: { items: [] } }),
            llmClient: makeLlmClient([toolCallResponse(), finalResponse()]),
        });

        const toolResult = conversation.turns[0].toolResults[0];
        // Bytes match the JSON the agent actually receives for the result.
        expect(toolResult.resultBytes).toBe(Buffer.byteLength(JSON.stringify(toolResult.result), 'utf8'));
    });

    it('leaves token totals undefined when the provider never reports usage', async () => {
        const conversation = await executeConversation({
            userPrompt: 'go',
            mcpClient: makeMcpClient({ toolName: 'search-actors', success: true, result: { items: [] } }),
            llmClient: makeLlmClient([toolCallResponse(), finalResponse()]),
        });

        expect(conversation.promptTokens).toBeUndefined();
        expect(conversation.completionTokens).toBeUndefined();
        expect(conversation.totalTokens).toBeUndefined();
    });

    it('records a tool call whose arguments are not valid JSON instead of aborting the item', async () => {
        const conversation = await executeConversation({
            userPrompt: 'go',
            mcpClient: makeMcpClient({ toolName: 'search-actors', success: true, result: { items: [] } }),
            llmClient: makeLlmClient([
                { content: null, toolCalls: [{ id: 'call-1', name: 'search-actors', arguments: '{"q":' }] },
                finalResponse(),
            ]),
        });

        // The turn keeps the call, and its result carries the parse error the agent saw.
        expect(conversation.turns[0].toolCalls).toEqual([{ name: 'search-actors', arguments: {} }]);
        expect(conversation.turns[0].toolResults[0]).toMatchObject({
            toolName: 'search-actors',
            success: false,
        });
        expect(conversation.turns[0].toolResults[0].error).toMatch(/Failed to parse arguments/);
    });

    it('returns the partial sum when only some turns report usage', async () => {
        const conversation = await executeConversation({
            userPrompt: 'go',
            mcpClient: makeMcpClient({ toolName: 'search-actors', success: true, result: { items: [] } }),
            llmClient: makeLlmClient([
                toolCallResponse(), // no usage on the first turn
                finalResponse({ promptTokens: 20, completionTokens: 7, totalTokens: 27 }),
            ]),
        });

        expect(conversation.promptTokens).toBe(20);
        expect(conversation.completionTokens).toBe(7);
        expect(conversation.totalTokens).toBe(27);
    });
});
