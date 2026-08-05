/**
 * LLM Judge for evaluating conversation quality
 * Uses structured output (JSON schema) for robust parsing
 */

// eslint-disable-next-line import/extensions
import type { ResponseFormatJSONSchema } from 'openai/resources/shared';

import type { WorkflowTestCase } from '../shared/types.js';
import { JUDGE_PROMPT_TEMPLATE, MODELS } from './config.js';
import type { SchemaValidityCheck, ToolSelectionCheck } from './deterministic_checks.js';
import { checkSchemaValidity, checkToolSelection } from './deterministic_checks.js';
import type { LlmClient } from './llm_client.js';
import type { ConversationHistory, McpTool } from './types.js';

/**
 * Verdict for one rubric dimension
 */
export type DimensionResult = { verdict: 'PASS' | 'FAIL'; reason: string };

/**
 * The fixed 6-dimension rubric, scored independently for every test case
 */
export type RubricResult = {
    toolSelection: DimensionResult;
    argumentCorrectness: DimensionResult;
    resultUtilization: DimensionResult;
    taskCompletion: DimensionResult;
    errorRecovery: DimensionResult;
    planEfficiency: DimensionResult;
};

/**
 * Rubric dimensions in display order, with the short glyph label used in the compact results table.
 */
export const RUBRIC_DIMENSIONS = [
    { key: 'toolSelection', glyph: 'tool', label: 'Tool selection' },
    { key: 'argumentCorrectness', glyph: 'args', label: 'Argument correctness' },
    { key: 'resultUtilization', glyph: 'result', label: 'Result utilization' },
    { key: 'taskCompletion', glyph: 'complete', label: 'Task completion' },
    { key: 'errorRecovery', glyph: 'recover', label: 'Error recovery' },
    { key: 'planEfficiency', glyph: 'eff', label: 'Plan efficiency' },
] as const satisfies readonly { key: keyof RubricResult; glyph: string; label: string }[];

/**
 * Judge evaluation result
 */
export type JudgeResult = {
    /** Mirrors rubric.taskCompletion.verdict — informational, the harness exit code does not use it */
    overallVerdict: 'PASS' | 'FAIL';
    /** The 6 rubric dimensions (toolSelection may be overridden by the deterministic check) */
    rubric: RubricResult;
    /** Deterministic expectedTools exact-match */
    toolSelectionCheck: ToolSelectionCheck;
    /** Deterministic per-call inputSchema validation */
    schemaValidityCheck: SchemaValidityCheck;
    /** Raw response from judge (for debugging) */
    rawResponse: string;
};

/** Per-result cap on tool output shown to the judge, so a huge dataset can't crowd out the rest. */
const MAX_RESULT_CHARS = 2000;

/**
 * JSON schema for structured judge output
 * Guarantees the LLM returns valid JSON matching this schema
 */
const DIMENSION_SCHEMA = {
    type: 'object',
    properties: {
        verdict: {
            type: 'string',
            enum: ['PASS', 'FAIL'],
            description: 'Whether the agent passed or failed this dimension',
        },
        reason: {
            type: 'string',
            description: 'Brief explanation in 1-2 sentences',
        },
    },
    required: ['verdict', 'reason'],
    additionalProperties: false,
};

const JUDGE_RESPONSE_SCHEMA: ResponseFormatJSONSchema = {
    type: 'json_schema',
    json_schema: {
        name: 'judge_evaluation',
        strict: true,
        schema: {
            type: 'object',
            properties: Object.fromEntries(RUBRIC_DIMENSIONS.map(({ key }) => [key, DIMENSION_SCHEMA])),
            required: RUBRIC_DIMENSIONS.map(({ key }) => key),
            additionalProperties: false,
        },
    },
};

/**
 * Serialize a tool result and cut it to `maxChars`, noting the cut so the judge knows the output
 * continued rather than ended.
 */
export function truncateResult(result: unknown, maxChars = MAX_RESULT_CHARS): string {
    const serialized = typeof result === 'string' ? result : JSON.stringify(result);
    if (serialized === undefined) return 'undefined';
    if (serialized.length <= maxChars) return serialized;
    return `${serialized.slice(0, maxChars)}  [truncated at ${maxChars} chars, ${serialized.length} total]`;
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
        // Show tool calls paired with their results (both arrays are filled in call order)
        for (const [index, toolCall] of turn.toolCalls.entries()) {
            lines.push(`AGENT: [Called tool: ${toolCall.name} with args: ${JSON.stringify(toolCall.arguments)}]`);

            const toolResult = turn.toolResults[index];
            if (!toolResult) continue;
            if (toolResult.success) {
                lines.push(`TOOL RESULT (${toolResult.toolName}): ${truncateResult(toolResult.result)}`);
            } else {
                // Show the error text, not "no result" — errorRecovery is scored on what the agent saw.
                lines.push(`TOOL ERROR (${toolResult.toolName}): ${truncateResult(toolResult.error)}`);
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
function parseJudgeResponse(response: string): RubricResult {
    let parsed: Partial<Record<keyof RubricResult, DimensionResult>>;
    try {
        parsed = JSON.parse(response) as Partial<Record<keyof RubricResult, DimensionResult>>;
    } catch (error) {
        throw new Error(
            `Failed to parse judge JSON response: ${error instanceof Error ? error.message : String(error)}\n` +
                `Raw response: ${response}`,
        );
    }

    // Validate the structure (should be guaranteed by schema, but double-check)
    for (const { key } of RUBRIC_DIMENSIONS) {
        const dimension = parsed[key];
        if (!dimension || (dimension.verdict !== 'PASS' && dimension.verdict !== 'FAIL')) {
            throw new Error(`Invalid verdict for dimension ${key}: ${JSON.stringify(dimension)}`);
        }
        if (!dimension.reason || typeof dimension.reason !== 'string') {
            throw new Error(`Invalid reason for dimension ${key}: ${JSON.stringify(dimension.reason)}`);
        }
    }

    return parsed as RubricResult;
}

/**
 * Build a JudgeResult for a test that errored before it could be judged.
 */
export function createErrorJudgeResult(reason: string): JudgeResult {
    const dimension: DimensionResult = { verdict: 'FAIL', reason };
    return {
        overallVerdict: 'FAIL',
        rubric: {
            toolSelection: dimension,
            argumentCorrectness: dimension,
            resultUtilization: dimension,
            taskCompletion: dimension,
            errorRecovery: dimension,
            planEfficiency: dimension,
        },
        toolSelectionCheck: { checked: false, verdict: null, expected: [], actual: [] },
        schemaValidityCheck: { verdict: 'PASS', invalidCalls: [] },
        rawResponse: '',
    };
}

/**
 * Evaluate a conversation using the judge LLM plus the deterministic checks.
 *
 * @param mcpTools - Tool list snapshot taken after the conversation finished, used to validate
 *                   each tool call's arguments against the tool's declared inputSchema
 */
export async function evaluateConversation(
    testCase: WorkflowTestCase,
    conversation: ConversationHistory,
    llmClient: LlmClient,
    judgeModel: string = MODELS.judge,
    mcpTools: McpTool[] = [],
): Promise<JudgeResult> {
    // Format conversation for judge
    const formattedConversation = formatConversationForJudge(conversation);

    // Create judge prompt using reference field
    const judgePrompt = JUDGE_PROMPT_TEMPLATE.replace('{{reference}}', testCase.reference || '').replace(
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
    const rubric = parseJudgeResponse(rawResponse);

    // Deterministic checks. When expectedTools is set, code decides toolSelection and the judge's
    // own answer for that dimension is discarded.
    const toolSelectionCheck = checkToolSelection(testCase.expectedTools, conversation);
    if (toolSelectionCheck.checked) {
        rubric.toolSelection = {
            verdict: toolSelectionCheck.verdict as 'PASS' | 'FAIL',
            reason:
                `Deterministic: expected [${toolSelectionCheck.expected.join(', ')}], ` +
                `got [${toolSelectionCheck.actual.join(', ')}]`,
        };
    }

    const schemaValidityCheck = checkSchemaValidity(conversation, mcpTools);

    return {
        overallVerdict: rubric.taskCompletion.verdict,
        rubric,
        toolSelectionCheck,
        schemaValidityCheck,
        rawResponse,
    };
}
