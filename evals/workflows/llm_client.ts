/**
 * LLM client for calling an OpenAI-compatible gateway
 * Phase 3: Added support for tool calling
 */

import { startActiveObservation } from '@langfuse/tracing';
import OpenAI from 'openai';
// eslint-disable-next-line import/extensions
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
// eslint-disable-next-line import/extensions
import type { ResponseFormatJSONSchema } from 'openai/resources/shared';

import { JUDGE_PROVIDER_CONFIG } from './config.js';

/**
 * Token usage reported by the LLM API for a single call
 */
export type LlmUsage = {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
};

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
    /** Token usage for this call (undefined if the provider did not report it) */
    usage?: LlmUsage;
};

/** Low temperature for deterministic evaluation results. */
const TEMPERATURE = 0.15;

/**
 * LLM client for chat completions with optional tool support
 */
export class LlmClient {
    private openai: OpenAI;

    constructor() {
        if (!JUDGE_PROVIDER_CONFIG.apiKey) {
            throw new Error('An LLM gateway API key is required (ORCAROUTER_API_KEY or OPENROUTER_API_KEY)');
        }

        this.openai = new OpenAI({
            baseURL: JUDGE_PROVIDER_CONFIG.baseURL,
            apiKey: JUDGE_PROVIDER_CONFIG.apiKey,
        });
    }

    /**
     * Call LLM with messages and optional tools
     * Phase 3: Added tools parameter
     * Phase 4: Added responseFormat for structured outputs
     *
     * Traced as a Langfuse generation, nested under whichever observation is active at the
     * call site: inside the experiment task that is the item's trace, so a judge call shows
     * up with its prompt, verdict, tokens, and cost.
     */
    async callLlm(
        messages: ChatCompletionMessageParam[],
        model: string,
        tools?: ChatCompletionTool[],
        responseFormat?: ResponseFormatJSONSchema,
    ): Promise<LlmResponse> {
        return startActiveObservation(
            model,
            async (generation) => {
                generation.update({ model, input: messages, modelParameters: { temperature: TEMPERATURE } });
                const llmResponse = await this.sendRequest(messages, model, tools, responseFormat);
                generation.update({
                    output: llmResponse.toolCalls ?? llmResponse.content,
                    ...(llmResponse.usage
                        ? {
                              usageDetails: {
                                  input: llmResponse.usage.promptTokens,
                                  output: llmResponse.usage.completionTokens,
                                  total: llmResponse.usage.totalTokens,
                              },
                          }
                        : {}),
                });
                return llmResponse;
            },
            { asType: 'generation' },
        );
    }

    /** The request itself, untraced. */
    private async sendRequest(
        messages: ChatCompletionMessageParam[],
        model: string,
        tools?: ChatCompletionTool[],
        responseFormat?: ResponseFormatJSONSchema,
    ): Promise<LlmResponse> {
        const response = await this.openai.chat.completions.create({
            model,
            messages,
            temperature: TEMPERATURE,
            ...(tools && tools.length > 0 ? { tools } : {}),
            ...(responseFormat ? { response_format: responseFormat } : {}),
        });

        const message = response.choices[0]?.message;

        if (!message) {
            throw new Error('LLM returned no message');
        }

        const usage: LlmUsage | undefined = response.usage
            ? {
                  promptTokens: response.usage.prompt_tokens,
                  completionTokens: response.usage.completion_tokens,
                  totalTokens: response.usage.total_tokens,
              }
            : undefined;

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
                usage,
            };
        }

        // Regular text response
        return {
            content: message.content || null,
            usage,
        };
    }
}
