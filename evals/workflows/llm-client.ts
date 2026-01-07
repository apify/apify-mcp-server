/**
 * LLM client for calling OpenRouter API
 * Phase 3: Added support for tool calling
 */

import OpenAI from 'openai';
// eslint-disable-next-line import/extensions
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';

import { OPENROUTER_CONFIG } from './config.js';

/**
 * Response from LLM - either text or tool calls
 */
export type LlmResponse = {
    /** Text content from LLM (if no tool calls) */
    content: string | null;
    /** Tool calls requested by LLM (if any) */
    toolCalls?: {
        id: string;
        name: string;
        arguments: string;
    }[];
}

/**
 * LLM client for chat completions with optional tool support
 */
export class LlmClient {
    private openai: OpenAI;

    constructor() {
        if (!OPENROUTER_CONFIG.apiKey) {
            throw new Error('OPENROUTER_API_KEY environment variable is required');
        }

        this.openai = new OpenAI({
            baseURL: OPENROUTER_CONFIG.baseURL,
            apiKey: OPENROUTER_CONFIG.apiKey,
        });
    }

    /**
     * Call LLM with messages and optional tools
     * Phase 3: Added tools parameter
     */
    async callLlm(
        messages: ChatCompletionMessageParam[],
        model: string,
        tools?: ChatCompletionTool[],
    ): Promise<LlmResponse> {
        const response = await this.openai.chat.completions.create({
            model,
            messages,
            temperature: 0.7,
            ...(tools && tools.length > 0 ? { tools } : {}),
        });

        const message = response.choices[0]?.message;

        if (!message) {
            throw new Error('LLM returned no message');
        }

        // Check if LLM wants to call tools
        if (message.tool_calls && message.tool_calls.length > 0) {
            return {
                content: message.content,
                toolCalls: message.tool_calls.map((tc) => {
                    // Handle both function and custom tool calls
                    if (tc.type === 'function') {
                        return {
                            id: tc.id,
                            name: tc.function.name,
                            arguments: tc.function.arguments,
                        };
                    }
                    throw new Error(`Unsupported tool call type: ${tc.type}`);
                }),
            };
        }

        // Regular text response
        return {
            content: message.content || null,
        };
    }
}
