import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { describe, expect, it } from 'vitest';

import { executeConversation } from '../../evals/workflows/conversation_executor.js';
import type { LlmClient, LlmResponse } from '../../evals/workflows/llm_client.js';
import type { McpClient } from '../../evals/workflows/mcp_client.js';
import type { ConversationTurn, McpToolResult } from '../../evals/workflows/types.js';

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
    it('appends evaluation instructions to the system prompt', async () => {
        let messages: ChatCompletionMessageParam[] = [];
        const llmClient = {
            callLlm: async (receivedMessages: ChatCompletionMessageParam[]): Promise<LlmResponse> => {
                messages = receivedMessages;
                return finalResponse();
            },
        } as unknown as LlmClient;

        await executeConversation({
            userPrompt: 'go',
            agentInstructions: 'Use Code Mode.',
            mcpClient: makeMcpClient({ toolName: 'search-actors', success: true }),
            llmClient,
        });

        expect(messages[0].content).toContain('## Evaluation Instructions');
        expect(messages[0].content).toContain('Use Code Mode.');
    });

    it('accumulates token usage across multiple turns', async () => {
        const conversation = await executeConversation({
            userPrompt: 'go',
            mcpClient: makeMcpClient({ toolName: 'search-actors', success: true, result: { items: [] } }),
            llmClient: makeLlmClient([
                toolCallResponse({
                    promptTokens: 10,
                    completionTokens: 5,
                    totalTokens: 15,
                    cachedPromptTokens: 3,
                    reasoningTokens: 2,
                }),
                finalResponse({
                    promptTokens: 20,
                    completionTokens: 7,
                    totalTokens: 27,
                    cachedPromptTokens: 4,
                    reasoningTokens: 1,
                }),
            ]),
        });

        expect(conversation.promptTokens).toBe(30);
        expect(conversation.completionTokens).toBe(12);
        expect(conversation.totalTokens).toBe(42);
        expect(conversation.cachedPromptTokens).toBe(7);
        expect(conversation.reasoningTokens).toBe(3);
        expect(conversation.turns.map((turn) => turn.usage?.totalTokens)).toEqual([15, 27]);
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
        expect(conversation.cachedPromptTokens).toBeUndefined();
        expect(conversation.reasoningTokens).toBeUndefined();
    });

    it('pushes turns into a caller-supplied array as they happen, not just at the end', async () => {
        const turns: ConversationTurn[] = [];

        const conversation = await executeConversation({
            userPrompt: 'go',
            mcpClient: makeMcpClient({ toolName: 'search-actors', success: true, result: { items: [] } }),
            llmClient: makeLlmClient([toolCallResponse(), toolCallResponse(), finalResponse()]),
            turns,
        });

        // Same array reference throughout — a caller that raced this call against a timeout
        // (see run_workflow_evals.ts) can read `turns` for whatever completed before the cutoff.
        expect(turns).toBe(conversation.turns);
        expect(turns).toHaveLength(3);
    });
});
