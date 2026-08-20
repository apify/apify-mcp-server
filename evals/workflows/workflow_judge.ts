/**
 * LLM Judge for evaluating conversation quality
 * Uses structured output (JSON schema) for robust parsing
 *
 * The judge scores six fixed dimensions rather than one pass/fail, so a regression points
 * at the capability that broke. `toolSelection` is replaced by a deterministic check on
 * the cases that can express one (see `deterministic_checks.ts`).
 */

// eslint-disable-next-line import/extensions
import type { ResponseFormatJSONSchema } from 'openai/resources/shared';
import { z } from 'zod';

import { JUDGE_PROMPT_TEMPLATE, MODELS } from './config.js';
import type { ToolSelectionCheck } from './deterministic_checks.js';
import { checkToolSelection } from './deterministic_checks.js';
import type { LlmClient } from './llm_client.js';
import type { ConversationHistory, ConversationToolCall } from './types.js';

/** One dimension's score. */
export type DimensionResult = { verdict: 'PASS' | 'FAIL'; reason: string };

/**
 * The rubric, identical for every test case.
 *
 * Fixed rather than per-case so a dimension's pass rate is comparable across the suite
 * and across runs.
 */
export type RubricResult = {
    toolSelection: DimensionResult;
    argumentCorrectness: DimensionResult;
    resultUtilization: DimensionResult;
    taskCompletion: DimensionResult;
    errorRecovery: DimensionResult;
    planEfficiency: DimensionResult;
};

/** Dimension keys in the order they are asked for, reported, and scored. */
export const DIMENSIONS = [
    'toolSelection',
    'argumentCorrectness',
    'resultUtilization',
    'taskCompletion',
    'errorRecovery',
    'planEfficiency',
] as const satisfies readonly (keyof RubricResult)[];

export type Dimension = (typeof DIMENSIONS)[number];

export type JudgeResult = {
    /**
     * The `taskCompletion` verdict, which is what "did this test pass" has always meant
     * here. Deliberately not an aggregate: a run where the answer was right but the path
     * was wasteful should stay visible as one failing dimension, not a failing test.
     */
    overallVerdict: 'PASS' | 'FAIL';
    rubric: RubricResult;
    toolSelectionCheck: ToolSelectionCheck;
    /** Raw response from judge (for debugging) */
    rawResponse: string;
};

/** One dimension, as the judge is asked to return it. */
const dimensionSchema = (description: string) => ({
    type: 'object',
    description,
    properties: {
        verdict: { type: 'string', enum: ['PASS', 'FAIL'] },
        reason: { type: 'string', description: 'One sentence explaining the verdict' },
    },
    required: ['verdict', 'reason'],
    additionalProperties: false,
});

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
                toolSelection: dimensionSchema('Whether the right tools were called, with nothing missing or extra'),
                argumentCorrectness: dimensionSchema('Whether the tool arguments were semantically correct'),
                resultUtilization: dimensionSchema('Whether the agent read and used what the tools returned'),
                taskCompletion: dimensionSchema('Whether the final response satisfied the requirements'),
                errorRecovery: dimensionSchema('Whether the agent handled failures and surprises sensibly'),
                planEfficiency: dimensionSchema('Whether the path to the answer was reasonably direct'),
            },
            required: [...DIMENSIONS],
            additionalProperties: false,
        },
    },
};

/**
 * Above this a tool result is cut in the judge prompt. A judge with a 1M context could
 * take more, but a single `get-dataset-items` call returning megabytes would drown the
 * conversation it is meant to explain.
 */
const MAX_RESULT_CHARS = 2000;

/** Serialize a tool result for the prompt, cut to `maxChars` with the cut declared. */
export function truncateResult(result: unknown, maxChars: number = MAX_RESULT_CHARS): string {
    const serialized = typeof result === 'string' ? result : JSON.stringify(result ?? null);
    if (serialized.length <= maxChars) return serialized;
    return `${serialized.slice(0, maxChars)} [truncated at ${maxChars} chars, ${serialized.length} total]`;
}

/** One tool call and what came back, as the judge reads it. */
function formatToolCall(toolCall: ConversationToolCall): string[] {
    const lines = [`AGENT: [Called tool: ${toolCall.name} with args: ${JSON.stringify(toolCall.arguments)}]`];
    const { result } = toolCall;

    // No result at all means the stream ended before one arrived - say so rather than
    // leave the call looking like it returned nothing.
    if (!result) lines.push(`TOOL RESULT (${toolCall.name}): [no result returned]`);
    // The error text, not a "failed" marker: errorRecovery is scored on what the agent
    // was told, and resultUtilization on whether it acted on it.
    else if (!result.success) lines.push(`TOOL ERROR (${toolCall.name}): ${result.error ?? '[unknown error]'}`);
    else lines.push(`TOOL RESULT (${toolCall.name}): ${truncateResult(result.result)}`);

    return lines;
}

/**
 * Format conversation for judge evaluation
 * Judge sees: tool calls + arguments + truncated tool results + final responses
 */
function formatConversationForJudge(conversation: ConversationHistory): string {
    const lines: string[] = [];

    // User prompt
    lines.push(`USER: ${conversation.userPrompt}`);
    lines.push('');

    // Each turn
    for (const turn of conversation.turns) {
        for (const toolCall of turn.toolCalls) {
            lines.push(...formatToolCall(toolCall));
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
const DimensionValidator = z.object({
    verdict: z
        .string()
        .trim()
        .toUpperCase()
        .pipe(z.enum(['PASS', 'FAIL'])),
    reason: z.string().min(1),
});

const JudgeResponseValidator = z.object({
    toolSelection: DimensionValidator,
    argumentCorrectness: DimensionValidator,
    resultUtilization: DimensionValidator,
    taskCompletion: DimensionValidator,
    errorRecovery: DimensionValidator,
    planEfficiency: DimensionValidator,
});

/**
 * Parse structured JSON response from judge
 */
function parseJudgeResponse(response: string): RubricResult {
    try {
        return JudgeResponseValidator.parse(JSON.parse(response));
    } catch (error) {
        throw new Error(
            `Failed to parse judge JSON response: ${error instanceof Error ? error.message : String(error)}\n` +
                `Raw response: ${response}`,
        );
    }
}

export type JudgeParams = {
    /** The test case's requirements, which the judge scores against. */
    reference: string;
    /**
     * Tools that constitute correct selection for this case. When set, `toolSelection` is
     * decided in code and the judge's own answer for it is dropped.
     */
    expectedTools?: string[];
    conversation: ConversationHistory;
    llmClient: LlmClient;
    judgeModel?: string;
};

/**
 * Evaluate a conversation using the judge LLM, then override the dimensions a
 * deterministic check can decide.
 */
export async function evaluateConversation(params: JudgeParams): Promise<JudgeResult> {
    const { reference, expectedTools, conversation, llmClient, judgeModel = MODELS.judge } = params;

    // Format conversation for judge
    const formattedConversation = formatConversationForJudge(conversation);

    // Create judge prompt using reference field. Both values are substituted through a
    // function so `$&`, `$'`, `` $` `` and `$$` (routine in Bash commands the agent runs)
    // are inserted literally instead of being read as replacement patterns.
    const judgePrompt = JUDGE_PROMPT_TEMPLATE.replace('{{reference}}', () => reference).replace(
        '{{conversation}}',
        () => formattedConversation,
    );

    // Call judge LLM with structured output schema
    const response = await llmClient.callLlm(
        [{ role: 'user', content: judgePrompt }],
        judgeModel,
        undefined, // No tools
        JUDGE_RESPONSE_SCHEMA, // Use structured output
    );

    const rawResponse = response.content || '';
    const rubric = parseJudgeResponse(rawResponse);

    // The check wins when it applies: the judge's toolSelection reasoning is dropped
    // rather than kept alongside, so there is one answer per dimension.
    const toolSelectionCheck = checkToolSelection(expectedTools, conversation);
    if (toolSelectionCheck.verdict) {
        rubric.toolSelection = {
            verdict: toolSelectionCheck.verdict,
            reason:
                `Deterministic: expected ${JSON.stringify(toolSelectionCheck.expected)}, ` +
                `got ${JSON.stringify(toolSelectionCheck.actual)}`,
        };
    }

    return {
        overallVerdict: rubric.taskCompletion.verdict,
        rubric,
        toolSelectionCheck,
        rawResponse,
    };
}
