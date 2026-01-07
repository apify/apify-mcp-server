/**
 * LLM Judge for evaluating conversation quality
 * Uses structured output (JSON schema) for robust parsing
 */

// eslint-disable-next-line import/extensions
import type { ResponseFormatJSONSchema } from 'openai/resources/shared';

import type { WorkflowTestCase } from '../shared/types.js';
import { JUDGE_PROMPT_TEMPLATE, MODELS } from './config.js';
import type { LlmClient } from './llm-client.js';
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
}

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
 * Parse structured JSON response from judge
 */
function parseJudgeResponse(response: string): { verdict: 'PASS' | 'FAIL'; reason: string } {
    try {
        const parsed = JSON.parse(response) as { verdict: 'PASS' | 'FAIL'; reason: string };

        // Validate the structure (should be guaranteed by schema, but double-check)
        if (!parsed.verdict || (parsed.verdict !== 'PASS' && parsed.verdict !== 'FAIL')) {
            throw new Error(`Invalid verdict: ${parsed.verdict}`);
        }

        if (!parsed.reason || typeof parsed.reason !== 'string') {
            throw new Error(`Invalid reason: ${parsed.reason}`);
        }

        return parsed;
    } catch (error) {
        throw new Error(
            `Failed to parse judge JSON response: ${error instanceof Error ? error.message : String(error)}\n`
            + `Raw response: ${response}`,
        );
    }
}

/**
 * Evaluate a conversation using the judge LLM
 */
export async function evaluateConversation(
    testCase: WorkflowTestCase,
    conversation: ConversationHistory,
    llmClient: LlmClient,
    judgeModel: string = MODELS.judge,
): Promise<JudgeResult> {
    // Format conversation for judge
    const formattedConversation = formatConversationForJudge(conversation);

    // Create judge prompt using reference field
    const judgePrompt = JUDGE_PROMPT_TEMPLATE
        .replace('{{reference}}', testCase.reference || '')
        .replace('{{conversation}}', formattedConversation);

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
            `Failed to parse judge response: ${error instanceof Error ? error.message : String(error)}\n`
            + `Raw response: ${rawResponse}`,
        );
    }
}
