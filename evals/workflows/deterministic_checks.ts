/**
 * Code-based rubric checks, for the parts of the rubric whose answer is knowable without
 * asking a model.
 *
 * A judged dimension is a probability; a check here is a fact. Whatever this file can
 * decide overrides the judge's own answer for that dimension in `workflow_judge.ts`.
 */

import type { ConversationHistory, ConversationToolCall } from './types.js';

/**
 * Whether the agent called exactly the tools the test case named.
 *
 * `checked` is false when the case set no `expectedTools`, which is the normal state for
 * a case with more than one valid path - the judge's own verdict stands then.
 */
export type ToolSelectionCheck = {
    checked: boolean;
    /** Null when `checked` is false. */
    verdict: 'PASS' | 'FAIL' | null;
    expected: string[];
    actual: string[];
};

/** Every tool call across the conversation, in call order. */
function toolCallsOf(conversation: ConversationHistory): ConversationToolCall[] {
    return conversation.turns.flatMap((turn) => turn.toolCalls);
}

/** Deduped and sorted, so the comparison ignores call order and repeat calls. */
function normalizeToolNames(names: string[]): string[] {
    return [...new Set(names)].sort();
}

/**
 * Exact set match of the tools called against the tools the case expects.
 *
 * Same semantics as `toolsExactMatch` in `evals/run_evaluation.ts`: dedupe, sort, compare
 * - so order and repeat calls of the same tool are ignored, while a missing or extra tool
 * fails. Claude Code's built-in tools are excluded: the agent reaches for `TodoWrite` or
 * `Read` on its own initiative, which says nothing about how it selected ours. The judge
 * still sees those calls and scores them under `planEfficiency`.
 */
export function checkToolSelection(
    expectedTools: string[] | undefined,
    conversation: ConversationHistory,
): ToolSelectionCheck {
    const actual = normalizeToolNames(
        toolCallsOf(conversation)
            .filter((call) => call.isMcpTool)
            .map((call) => call.name),
    );

    if (expectedTools === undefined || expectedTools.length === 0) {
        return { checked: false, verdict: null, expected: [], actual };
    }

    const expected = normalizeToolNames(expectedTools);

    return {
        checked: true,
        verdict: JSON.stringify(expected) === JSON.stringify(actual) ? 'PASS' : 'FAIL',
        expected,
        actual,
    };
}
