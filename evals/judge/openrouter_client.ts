/**
 * LLM client for calling OpenRouter API
 */

import { startActiveObservation } from '@langfuse/tracing';
import OpenAI from 'openai';
// eslint-disable-next-line import/extensions
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
// eslint-disable-next-line import/extensions
import type { ResponseFormatJSONSchema } from 'openai/resources/shared';

import { sanitizeEnvValue } from '../environment.js';
import { type JudgeClient, type LlmResponse, type LlmUsage, toUsageDetails } from './client.js';

/** OpenRouter API configuration */
export const OPENROUTER_CONFIG = {
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: sanitizeEnvValue(process.env.OPENROUTER_API_KEY) || '',
};

/** Low temperature for deterministic evaluation results. */
const TEMPERATURE = 0.15;

export class OpenRouterClient implements JudgeClient {
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
     * Traced as a Langfuse generation, nested under whichever observation is active at the
     * call site: inside the experiment task that is the item's trace, so a judge call shows
     * up with its prompt, verdict, tokens, and cost.
     */
    async callLlm(
        messages: ChatCompletionMessageParam[],
        model: string,
        responseFormat?: ResponseFormatJSONSchema,
    ): Promise<LlmResponse> {
        return startActiveObservation(
            model,
            async (generation) => {
                generation.update({ model, input: messages, modelParameters: { temperature: TEMPERATURE } });
                const llmResponse = await this.sendRequest(messages, model, responseFormat);
                generation.update({
                    output: llmResponse.content,
                    ...toUsageDetails(llmResponse.usage),
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
        responseFormat?: ResponseFormatJSONSchema,
    ): Promise<LlmResponse> {
        const response = await this.openai.chat.completions.create({
            model,
            messages,
            temperature: TEMPERATURE,
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

        return {
            content: message.content || null,
            usage,
        };
    }
}
