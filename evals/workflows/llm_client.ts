/**
 * LLM client for calling OpenRouter API
 * Phase 3: Added support for tool calling
 */

import { startActiveObservation } from '@langfuse/tracing';
import OpenAI from 'openai';
// eslint-disable-next-line import/extensions
import type {
    ChatCompletionCreateParamsNonStreaming,
    ChatCompletionMessageParam,
    ChatCompletionTool,
} from 'openai/resources/chat/completions';
// eslint-disable-next-line import/extensions
import type { ResponseFormatJSONSchema } from 'openai/resources/shared';

import { OPENROUTER_CONFIG } from './config.js';

/** Low temperature for deterministic evaluation results. */
const TEMPERATURE = 0.15;

/**
 * Token usage reported by the LLM API for a single call
 */
export type LlmUsage = {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
};

/**
 * OpenRouter's usage-accounting extension: with `usage: { include: true }` in the
 * request, the usage payload carries what the call actually cost, in USD.
 */
type OpenRouterUsage = OpenAI.CompletionUsage & { cost?: number };

/** A chat completion request plus OpenRouter's usage-accounting opt-in. */
type OpenRouterCreateParams = ChatCompletionCreateParamsNonStreaming & { usage?: { include: boolean } };

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
     * Phase 4: Added responseFormat for structured outputs
     *
     * Each call is recorded as a Langfuse generation. No-ops when tracing is not
     * initialized (OTel returns a no-op tracer).
     */
    async callLlm(
        messages: ChatCompletionMessageParam[],
        model: string,
        tools?: ChatCompletionTool[],
        responseFormat?: ResponseFormatJSONSchema,
    ): Promise<LlmResponse> {
        return startActiveObservation(
            'OpenAI.chat',
            async (generation) => {
                generation.update({ model, input: messages, modelParameters: { temperature: TEMPERATURE } });

                // Typed as an intersection rather than cast whole: `usage` is an OpenRouter
                // extension absent from the OpenAI types, and casting the object literal
                // would also stop model/messages/tools/response_format being checked.
                const params: OpenRouterCreateParams = {
                    model,
                    messages,
                    temperature: TEMPERATURE,
                    // OpenRouter extension: report what the call cost.
                    usage: { include: true },
                    ...(tools && tools.length > 0 ? { tools } : {}),
                    ...(responseFormat ? { response_format: responseFormat } : {}),
                };

                const response = await this.openai.chat.completions.create(params);

                const message = response.choices[0]?.message;

                if (!message) {
                    throw new Error('LLM returned no message');
                }

                const rawUsage = response.usage as OpenRouterUsage | undefined;
                const usage: LlmUsage | undefined = rawUsage
                    ? {
                          promptTokens: rawUsage.prompt_tokens,
                          completionTokens: rawUsage.completion_tokens,
                          totalTokens: rawUsage.total_tokens,
                      }
                    : undefined;

                // Cost comes from the provider, not from Langfuse's price table: the table
                // is keyed by canonical model names and has no entry for OpenRouter's, so
                // matching it would mean maintaining a price per model we ever evaluate.
                generation.update({
                    output: message,
                    model: response.model,
                    ...(usage
                        ? {
                              usageDetails: {
                                  input: usage.promptTokens,
                                  output: usage.completionTokens,
                                  total: usage.totalTokens,
                              },
                          }
                        : {}),
                    ...(rawUsage?.cost === undefined ? {} : { costDetails: { total: rawUsage.cost } }),
                });

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
            },
            { asType: 'generation' },
        );
    }
}
