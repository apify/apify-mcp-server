/**
 * LLM Judge for evaluating conversation quality
 * Uses structured output (JSON schema) for robust parsing
 */

// eslint-disable-next-line import/extensions
import type { ResponseFormatJSONSchema } from 'openai/resources/shared';
import { z } from 'zod';

import { JUDGE_PROMPT_TEMPLATE, MODELS } from './config.js';
import type { JudgeLlmClient } from './llm_client.js';
import type { ConversationHistory } from './types.js';

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

/** Judge calls per item before the parse failure is fatal. */
const JUDGE_PARSE_ATTEMPTS = 2;

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
 * Format conversation for judge evaluation
 * Judge sees: tool calls + arguments + final responses (NOT tool results)
 */
function formatConversationForJudge(conversation: ConversationHistory): string {
    const lines: string[] = [];

    // User prompt
    lines.push(`USER: ${conversation.userPrompt}`);
    lines.push('');

    // Each turn
    for (const turn of conversation.turns) {
        // Show tool calls (if any)
        if (turn.toolCalls.length > 0) {
            for (const toolCall of turn.toolCalls) {
                lines.push(`AGENT: [Called tool: ${toolCall.name} with args: ${JSON.stringify(toolCall.arguments)}]`);
            }
        }

        // Show final response (if present)
        if (turn.finalResponse) {
            lines.push(`AGENT: ${turn.finalResponse}`);
        }

        lines.push('');
    }

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
 * Some providers answer in prose that still opens with the verdict ("FAIL. The agent ...").
 * Recover the verdict and use the rest as the reason before spending a retry call on it.
 * Anything not opening with PASS/FAIL stays unparsed.
 */
const PROSE_VERDICT_PATTERN = /^\s*(PASS|FAIL)\b[.:!-]?\s*(.*)$/is;

/**
 * Parse the judge response: strict JSON first, prose-verdict fallback second.
 */
export function parseJudgeResponse(response: string): { verdict: 'PASS' | 'FAIL'; reason: string } {
    try {
        return JudgeResponseValidator.parse(JSON.parse(response));
    } catch (error) {
        const prose = PROSE_VERDICT_PATTERN.exec(response);
        if (prose) {
            return {
                verdict: prose[1].toUpperCase() as 'PASS' | 'FAIL',
                reason: prose[2].trim() || 'no reason given',
            };
        }
        // No raw response here: the retry loop's final throw already carries it.
        throw new Error(
            `Failed to parse judge JSON response: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

/**
 * Evaluate a conversation using the judge LLM
 */
export async function evaluateConversation(
    reference: string,
    conversation: ConversationHistory,
    llmClient: JudgeLlmClient,
    judgeModel: string = MODELS.judge,
): Promise<JudgeResult> {
    // Format conversation for judge
    const formattedConversation = formatConversationForJudge(conversation);

    // Create judge prompt using reference field. Both values are substituted through a
    // function so `$&`, `$'`, `` $` `` and `$$` (routine in Bash commands the agent runs)
    // are inserted literally instead of being read as replacement patterns.
    const judgePrompt = JUDGE_PROMPT_TEMPLATE.replace('{{reference}}', () => reference).replace(
        '{{conversation}}',
        () => formattedConversation,
    );

    // Some OpenRouter providers occasionally ignore the JSON schema and answer in plain
    // text (e.g. "PASS: ..."). One fresh judge call recovers those without rerunning the
    // far more expensive agent conversation; a second malformed answer still throws.
    let lastError: unknown;
    let lastRawResponse = '';
    for (let attempt = 1; attempt <= JUDGE_PARSE_ATTEMPTS; attempt++) {
        const response = await llmClient.callLlm(
            [{ role: 'user', content: judgePrompt }],
            judgeModel,
            undefined, // No tools
            JUDGE_RESPONSE_SCHEMA,
        );
        lastRawResponse = response.content || '';

        try {
            return { ...parseJudgeResponse(lastRawResponse), rawResponse: lastRawResponse };
        } catch (error) {
            lastError = error;
        }
    }
    // The raw answer is the only evidence of what the judge actually said; without it the
    // failure is undebuggable.
    throw new Error(
        `Failed to parse judge response after ${JUDGE_PARSE_ATTEMPTS} attempts: ` +
            `${lastError instanceof Error ? lastError.message : String(lastError)}\n` +
            `Last raw response: ${lastRawResponse}`,
    );
}
