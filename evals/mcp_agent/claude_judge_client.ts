/**
 * Judge LLM client backed by the Claude Agent SDK, for runs without an OpenRouter key.
 *
 * Selected with `--claude-judge`. Each call spawns a short-lived Claude Code subprocess
 * (no tools, one turn) that authenticates like the `--subscription` agent does: local
 * Claude Code login, or whatever provider the environment supplies. The SDK exposes no
 * temperature control, so verdicts are less deterministic than OpenRouter's 0.15 — the
 * structured verdict schema keeps that from mattering in practice.
 */

import { tmpdir } from 'node:os';

import { query } from '@anthropic-ai/claude-agent-sdk';
import { startActiveObservation } from '@langfuse/tracing';
// eslint-disable-next-line import/extensions
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
// eslint-disable-next-line import/extensions
import type { ResponseFormatJSONSchema } from 'openai/resources/shared';

import { type LlmResponse, type LlmUsage, toUsageDetails } from './llm_client.js';

/**
 * The model's answer may wrap the verdict JSON in code fences or prose. Return the JSON
 * object substring (first '{' to last '}'), or the input unchanged when there is none —
 * the caller's JSON parse then fails with the raw text in the error.
 */
export function extractJsonObject(text: string): string {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return text;
    return text.slice(start, end + 1);
}

/** Flatten chat messages into one prompt; the judge sends a single user message. */
function messagesToPrompt(messages: ChatCompletionMessageParam[]): string {
    return messages
        .map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)))
        .join('\n\n');
}

export class ClaudeLlmClient {
    /**
     * Same surface as `LlmClient.callLlm`, judge subset: no tool support (the judge never
     * passes tools), `responseFormat` is enforced by instruction + extraction rather than
     * by the API. Traced as a Langfuse generation like the OpenRouter client.
     */
    async callLlm(
        messages: ChatCompletionMessageParam[],
        model: string,
        tools?: ChatCompletionTool[],
        responseFormat?: ResponseFormatJSONSchema,
    ): Promise<LlmResponse> {
        if (tools && tools.length > 0) {
            throw new Error('ClaudeLlmClient supports judge calls only (no tools)');
        }

        let prompt = messagesToPrompt(messages);
        if (responseFormat) {
            prompt +=
                `\n\nRespond with a single JSON object only - no prose, no code fences - ` +
                `matching this JSON schema:\n${JSON.stringify(responseFormat.json_schema.schema)}`;
        }

        return startActiveObservation(
            model,
            async (generation) => {
                generation.update({ model, input: messages });
                const llmResponse = await this.sendRequest(prompt, model);
                if (responseFormat && llmResponse.content) {
                    llmResponse.content = extractJsonObject(llmResponse.content);
                }
                generation.update({
                    output: llmResponse.content,
                    ...toUsageDetails(llmResponse.usage),
                });
                return llmResponse;
            },
            { asType: 'generation' },
        );
    }

    /** One single-turn, tool-less Claude Code run; its result text is the LLM response. */
    private async sendRequest(prompt: string, model: string): Promise<LlmResponse> {
        // No tools and one turn: nothing needs permissions, so the default permission mode
        // works everywhere (bypassPermissions would refuse to run as root without a sandbox).
        for await (const message of query({
            prompt,
            options: {
                model,
                maxTurns: 1,
                tools: [],
                settingSources: [],
                cwd: tmpdir(),
            },
        })) {
            if (message.type !== 'result') continue;
            if (message.subtype !== 'success') {
                const detail = message.errors.join('; ') || 'no error detail';
                throw new Error(`Claude judge run ended with "${message.subtype}": ${detail}`);
            }
            let usage: LlmUsage | undefined;
            if (message.usage) {
                // Cached input tokens count as prompt tokens, like OpenRouter reports them.
                const promptTokens =
                    message.usage.input_tokens +
                    (message.usage.cache_read_input_tokens ?? 0) +
                    (message.usage.cache_creation_input_tokens ?? 0);
                usage = {
                    promptTokens,
                    completionTokens: message.usage.output_tokens,
                    totalTokens: promptTokens + message.usage.output_tokens,
                };
            }
            return { content: message.result, usage };
        }
        throw new Error('Claude judge run produced no result message');
    }
}
