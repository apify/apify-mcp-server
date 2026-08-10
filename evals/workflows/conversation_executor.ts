/**
 * Multi-turn conversation executor
 * Handles the loop: LLM → Tool calls → Execute tools → Add to messages → Repeat
 */

// eslint-disable-next-line import/extensions
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';

import { mcpToolsToOpenAiTools } from '../shared/openai_tools.js';
import { AGENT_SYSTEM_PROMPT, MAX_CONVERSATION_TURNS, MODELS } from './config.js';
import type { LlmClient } from './llm_client.js';
import type { McpClient } from './mcp_client.js';
import type { ConversationHistory, ConversationTurn, McpToolResult } from './types.js';

/** Outcome of parsing one tool call's arguments. */
type ParsedToolArguments = { ok: true; args: Record<string, unknown> } | { ok: false; error: string };

/**
 * Parse tool-call arguments without throwing. An agent model can emit invalid JSON,
 * and that is a tool-call failure to record and feed back to it, not a reason to
 * abort the test case.
 */
function parseToolArguments(rawArguments: string): ParsedToolArguments {
    try {
        return { ok: true, args: JSON.parse(rawArguments) as Record<string, unknown> };
    } catch (error) {
        return { ok: false, error: `Failed to parse arguments: ${error}` };
    }
}

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
};

/**
 * Execute a multi-turn conversation with tool calling
 * Tools are fetched dynamically from MCP after each turn
 */
export async function executeConversation(options: ConversationExecutorOptions): Promise<ConversationHistory> {
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
    let totalTokens = 0;
    // Track whether the provider ever reported usage; if it never does, the total stays
    // undefined rather than a fabricated 0 that reads as a real measurement.
    let hasUsage = false;

    // Fetch tools initially
    let tools: ChatCompletionTool[] = mcpToolsToOpenAiTools(mcpClient.getTools());

    while (turnNumber < maxTurns) {
        turnNumber++;

        // Call LLM with current conversation state and current tools
        const llmResponse = await llmClient.callLlm(messages, model, tools);

        // Accumulate token usage across the agent loop (cost grows with tool-result size)
        if (llmResponse.usage) {
            hasUsage = true;
            totalTokens += llmResponse.usage.totalTokens;
        }

        // Check if LLM wants to call tools
        if (!llmResponse.toolCalls || llmResponse.toolCalls.length === 0) {
            // No tool calls - this is the final response
            turns.push({
                turnNumber,
                toolCalls: [],
                toolResults: [],
                finalResponse: llmResponse.content || '',
            });

            break;
        }

        // LLM wants to call tools. Parse the arguments once: the same outcome feeds the
        // recorded turn and the execution loop below.
        const toolCalls = llmResponse.toolCalls.map((toolCall) => ({
            ...toolCall,
            parsed: parseToolArguments(toolCall.arguments),
        }));

        const turn: ConversationTurn = {
            turnNumber,
            toolCalls: toolCalls.map(({ name, parsed }) => ({ name, arguments: parsed.ok ? parsed.args : {} })),
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
        for (const toolCall of toolCalls) {
            const { parsed } = toolCall;
            if (!parsed.ok) {
                // Invalid JSON arguments
                const errorContent = JSON.stringify({ error: parsed.error });
                const errorResult: McpToolResult = {
                    toolName: toolCall.name,
                    success: false,
                    error: parsed.error,
                    resultBytes: Buffer.byteLength(errorContent, 'utf8'),
                };
                turn.toolResults.push(errorResult);

                // Add error to conversation
                messages.push({
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    content: errorContent,
                });
                continue;
            }

            // Execute tool via MCP
            const result = await mcpClient.callTool({
                name: toolCall.name,
                arguments: parsed.args,
            });

            // Serialize the tool result exactly as the agent (LLM) receives it,
            // and record its byte size to measure the data volume tools return.
            const content = result.success ? JSON.stringify(result.result) : JSON.stringify({ error: result.error });
            result.resultBytes = Buffer.byteLength(content, 'utf8');

            turn.toolResults.push(result);

            // Add tool result to conversation
            messages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content,
            });
        }

        turns.push(turn);

        // Refresh tools after executing tool calls
        // Tools can still change dynamically for a restored pre-cutover session with add-actor
        // loaded (no longer selectable for new sessions). Fetch fresh tools for next turn
        tools = mcpToolsToOpenAiTools(mcpClient.getTools());
    }

    return {
        userPrompt,
        turns,
        totalTokens: hasUsage ? totalTokens : undefined,
    };
}
