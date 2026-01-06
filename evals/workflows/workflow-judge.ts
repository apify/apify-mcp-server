/**
 * LLM Judge for evaluating conversation quality
 */

import { JUDGE_PROMPT_TEMPLATE, MODELS } from './config.js';
import { LlmClient } from './llm-client.js';
import type { ConversationHistory } from './types.js';

/**
 * Test case for evaluation (minimal structure needed for judge)
 */
export interface TestCase {
    /** Test case ID */
    id: string;
    /** User prompt */
    prompt: string;
    /** Requirements that must be met */
    requirements: string;
}

/**
 * Judge evaluation result
 */
export interface JudgeResult {
    /** PASS or FAIL verdict */
    verdict: 'PASS' | 'FAIL';
    /** Explanation from judge */
    reason: string;
    /** Raw response from judge (for debugging) */
    rawResponse: string;
}

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
 * Parse judge response to extract verdict and reason
 */
function parseJudgeResponse(response: string): { verdict: 'PASS' | 'FAIL'; reason: string } {
    const lines = response.trim().split('\n');
    
    let verdict: 'PASS' | 'FAIL' | null = null;
    let reason = '';

    for (const line of lines) {
        const trimmedLine = line.trim();
        
        if (trimmedLine.startsWith('VERDICT:')) {
            const verdictText = trimmedLine.replace('VERDICT:', '').trim().toUpperCase();
            if (verdictText === 'PASS' || verdictText === 'FAIL') {
                verdict = verdictText;
            }
        } else if (trimmedLine.startsWith('REASON:')) {
            reason = trimmedLine.replace('REASON:', '').trim();
        }
    }

    if (!verdict) {
        throw new Error(`Failed to parse judge verdict from response: ${response}`);
    }

    if (!reason) {
        throw new Error(`Failed to parse judge reason from response: ${response}`);
    }

    return { verdict, reason };
}

/**
 * Evaluate a conversation using the judge LLM
 */
export async function evaluateConversation(
    testCase: TestCase,
    conversation: ConversationHistory,
    llmClient: LlmClient,
    judgeModel: string = MODELS.judge,
): Promise<JudgeResult> {
    // Format conversation for judge
    const formattedConversation = formatConversationForJudge(conversation);

    // Create judge prompt
    const judgePrompt = JUDGE_PROMPT_TEMPLATE
        .replace('{{requirements}}', testCase.requirements)
        .replace('{{conversation}}', formattedConversation);

    // Call judge LLM
    const response = await llmClient.callLlm(
        [{ role: 'user', content: judgePrompt }],
        judgeModel,
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
            `Raw response: ${rawResponse}`
        );
    }
}
