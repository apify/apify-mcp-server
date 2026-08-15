/**
 * LLM Judge for evaluating conversation quality
 * Uses structured output (JSON schema) for robust parsing
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
// eslint-disable-next-line import/extensions
import type { ResponseFormatJSONSchema } from 'openai/resources/shared';
import { z } from 'zod';

import { JUDGE_PROMPT_TEMPLATE, MODELS, stripToolPrefix } from './config.js';
import type { LlmClient } from './llm_client.js';
import { isMainAgentMessage, readBlocks, readText } from './sdk_messages.js';

/**
 * Judge evaluation result
 */
export type JudgeResult = {
    /** PASS or FAIL verdict */
    verdict: 'PASS' | 'FAIL';
    /** Explanation from judge */
    reason: string;
    /** Raw response from judge (for debugging) */
    rawResponse: string;
};

/**
 * JSON schema for structured judge output
 * Guarantees the LLM returns valid JSON matching this schema
 */
const JUDGE_RESPONSE_SCHEMA: ResponseFormatJSONSchema = {
    type: 'json_schema',
    json_schema: {
        name: 'judge_evaluation',
        strict: true,
        schema: {
            type: 'object',
            properties: {
                verdict: {
                    type: 'string',
                    enum: ['PASS', 'FAIL'],
                    description: 'Whether the agent passed or failed the evaluation',
                },
                reason: {
                    type: 'string',
                    description: 'Brief explanation in 1-2 sentences explaining why the agent passed or failed',
                },
            },
            required: ['verdict', 'reason'],
            additionalProperties: false,
        },
    },
};

/**
 * Format the SDK message stream for the judge.
 *
 * Judge sees: tool calls + arguments + final responses (NOT tool results). One block per
 * assistant message; narration that accompanies a tool call is withheld, so the judge reads
 * the agent's actions and its answer, never its reasoning about them. The final answer comes
 * from the `result` message unless the last assistant message already carried it alone.
 */
export function formatSdkStreamForJudge(userPrompt: string, messages: SDKMessage[]): string {
    const lines: string[] = [`USER: ${userPrompt}`, ''];
    // The answer the last assistant message stands on its own; '' when it called tools.
    let trailingAnswer = '';
    let finalResult = '';

    for (const message of messages) {
        if (message.type === 'result') {
            if (message.subtype === 'success') finalResult = message.result.trim();
            continue;
        }
        if (message.type !== 'assistant' || !isMainAgentMessage(message)) continue;

        const blocks = readBlocks(message.message.content);
        const toolUses = blocks.filter((block) => block.type === 'tool_use');

        for (const block of toolUses) {
            const args = JSON.stringify((block.input ?? {}) as Record<string, unknown>);
            lines.push(`AGENT: [Called tool: ${stripToolPrefix(block.name)} with args: ${args}]`);
        }

        trailingAnswer = toolUses.length > 0 ? '' : readText(blocks);
        if (trailingAnswer) lines.push(`AGENT: ${trailingAnswer}`);
        lines.push('');
    }

    // Append the result text unless the last assistant message already is it.
    if (finalResult && !trailingAnswer) lines.push(`AGENT: ${finalResult}`, '');

    return lines.join('\n').trim();
}

/**
 * Judge output as it comes back over the wire. JUDGE_RESPONSE_SCHEMA asks for a strict
 * schema, but that is only honoured by some OpenRouter providers, so normalize the
 * casing the judge actually reached a verdict in rather than discard the item.
 * Structure only: an unrecognized verdict stays an error, never a guess.
 */
const JudgeResponseValidator = z.object({
    verdict: z
        .string()
        .trim()
        .toUpperCase()
        .pipe(z.enum(['PASS', 'FAIL'])),
    reason: z.string().min(1),
});

/**
 * Parse structured JSON response from judge
 */
function parseJudgeResponse(response: string): { verdict: 'PASS' | 'FAIL'; reason: string } {
    try {
        return JudgeResponseValidator.parse(JSON.parse(response));
    } catch (error) {
        throw new Error(
            `Failed to parse judge JSON response: ${error instanceof Error ? error.message : String(error)}\n` +
                `Raw response: ${response}`,
        );
    }
}

/**
 * Evaluate a conversation using the judge LLM
 */
export async function evaluateConversation(
    reference: string,
    userPrompt: string,
    messages: SDKMessage[],
    llmClient: LlmClient,
    judgeModel: string = MODELS.judge,
): Promise<JudgeResult> {
    const formattedConversation = formatSdkStreamForJudge(userPrompt, messages);

    // Create judge prompt using reference field
    const judgePrompt = JUDGE_PROMPT_TEMPLATE.replace('{{reference}}', reference).replace(
        '{{conversation}}',
        formattedConversation,
    );

    // Call judge LLM with structured output schema
    const response = await llmClient.callLlm(
        [{ role: 'user', content: judgePrompt }],
        judgeModel,
        undefined, // No tools
        JUDGE_RESPONSE_SCHEMA, // Use structured output
    );

    const rawResponse = response.content || '';

    // Parse response
    try {
        const { verdict, reason } = parseJudgeResponse(rawResponse);
        return {
            verdict,
            reason,
            rawResponse,
        };
    } catch (error) {
        throw new Error(
            `Failed to parse judge response: ${error instanceof Error ? error.message : String(error)}\n` +
                `Raw response: ${rawResponse}`,
        );
    }
}
