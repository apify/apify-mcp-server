/**
 * Multi-turn conversation executor
 * Handles the loop: LLM → Tool calls → Execute tools → Add to messages → Repeat
 */

// eslint-disable-next-line import/extensions
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';

import { mcpToolsToOpenAiTools } from '../shared/openai-tools.js';
import { AGENT_SYSTEM_PROMPT, MAX_CONVERSATION_TURNS, MODELS } from './config.js';
import type { LlmClient } from './llm-client.js';
import type { McpClient } from './mcp-client.js';
import type { ConversationHistory, ConversationTurn } from './types.js';

export type ConversationExecutorOptions = {
    /** User's initial prompt */
    userPrompt: string;
    /** MCP client for tool execution and dynamic tool fetching */
    mcpClient: McpClient;
    /** LLM client for chat completions */
    llmClient: LlmClient;
    /** Maximum number of turns (optional, uses config default) */
    maxTurns?: number;
    /** Model to use (optional, uses config default) */
    model?: string;
    /** Additional instructions from MCP server (optional) */
    serverInstructions?: string | null;
}

/**
 * Execute a multi-turn conversation with tool calling
 * Tools are fetched dynamically from MCP after each turn
 */
export async function executeConversation(
    options: ConversationExecutorOptions,
): Promise<ConversationHistory> {
    const {
        userPrompt,
        mcpClient,
        llmClient,
        maxTurns = MAX_CONVERSATION_TURNS,
        model = MODELS.agent,
        serverInstructions,
    } = options;

    const turns: ConversationTurn[] = [];

    // Build system prompt with optional server instructions
    let systemPrompt = AGENT_SYSTEM_PROMPT;
    if (serverInstructions) {
        systemPrompt += `\n\n## MCP Server Instructions\n\n${serverInstructions}`;
    }

    const messages: ChatCompletionMessageParam[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
    ];

    let turnNumber = 0;
    let completed = false;

    // Fetch tools initially
    let tools: ChatCompletionTool[] = mcpToolsToOpenAiTools(mcpClient.getTools());

    while (turnNumber < maxTurns) {
        turnNumber++;

        // Call LLM with current conversation state and current tools
        const llmResponse = await llmClient.callLlm(messages, model, tools);

        // Check if LLM wants to call tools
        if (!llmResponse.toolCalls || llmResponse.toolCalls.length === 0) {
            // No tool calls - this is the final response
            turns.push({
                turnNumber,
                toolCalls: [],
                toolResults: [],
                finalResponse: llmResponse.content || '',
            });

            completed = true;
            break;
        }

        // LLM wants to call tools
        const turn: ConversationTurn = {
            turnNumber,
            toolCalls: llmResponse.toolCalls.map((tc) => ({
                name: tc.name,
                arguments: JSON.parse(tc.arguments),
            })),
            toolResults: [],
        };

        // Add assistant message with tool calls to conversation
        messages.push({
            role: 'assistant',
            content: llmResponse.content,
            tool_calls: llmResponse.toolCalls.map((tc) => ({
                id: tc.id,
                type: 'function' as const,
                function: {
                    name: tc.name,
                    arguments: tc.arguments,
                },
            })),
        });

        // Execute each tool call
        for (const toolCall of llmResponse.toolCalls) {
            let args: Record<string, unknown>;
            try {
                args = JSON.parse(toolCall.arguments);
            } catch (error) {
                // Invalid JSON arguments
                const errorResult = {
                    toolName: toolCall.name,
                    success: false,
                    error: `Failed to parse arguments: ${error}`,
                };
                turn.toolResults.push(errorResult);

                // Add error to conversation
                messages.push({
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    content: JSON.stringify({ error: errorResult.error }),
                });
                continue;
            }

            // Execute tool via MCP
            const result = await mcpClient.callTool({
                name: toolCall.name,
                arguments: args,
            });

            turn.toolResults.push(result);

            // Add tool result to conversation
            if (result.success) {
                messages.push({
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    content: JSON.stringify(result.result),
                });
            } else {
                messages.push({
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    content: JSON.stringify({ error: result.error }),
                });
            }
        }

        turns.push(turn);

        // Refresh tools after executing tool calls
        // Tools can change dynamically (e.g., add-actor adds new tools)
        // Fetch fresh tools from MCP server for next turn
        tools = mcpToolsToOpenAiTools(mcpClient.getTools());
    }

    return {
        userPrompt,
        turns,
        completed,
        hitMaxTurns: turnNumber >= maxTurns && !completed,
        totalTurns: turnNumber,
    };
}
