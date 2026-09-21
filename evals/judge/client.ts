/**
 * The LLM contract the judge calls through, shared by the OpenRouter client
 * (default) and the Claude Agent SDK client (`--claude-judge`).
 */

// eslint-disable-next-line import/extensions
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
// eslint-disable-next-line import/extensions
import type { ResponseFormatJSONSchema } from 'openai/resources/shared';

/**
 * Token usage reported by the LLM API for a single call
 */
export type LlmUsage = {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
};

export type LlmResponse = {
    /** Text content from LLM */
    content: string | null;
    /** Token usage for this call (undefined if the provider did not report it) */
    usage?: LlmUsage;
};

/**
 * What the judge needs from an LLM client. Implemented by `OpenRouterClient`
 * and `ClaudeJudgeClient` (Claude Agent SDK, `--claude-judge`).
 */
export interface JudgeClient {
    callLlm(
        messages: ChatCompletionMessageParam[],
        model: string,
        responseFormat?: ResponseFormatJSONSchema,
    ): Promise<LlmResponse>;
}

/** Langfuse generation-update fields for a usage report; empty when the provider sent none. */
export function toUsageDetails(usage?: LlmUsage): { usageDetails?: { input: number; output: number; total: number } } {
    if (!usage) return {};
    return {
        usageDetails: {
            input: usage.promptTokens,
            output: usage.completionTokens,
            total: usage.totalTokens,
        },
    };
}
