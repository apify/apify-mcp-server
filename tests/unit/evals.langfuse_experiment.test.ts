import { describe, expect, it } from 'vitest';

import { buildRunSummary, evaluators, type WorkflowTaskOutput } from '../../evals/workflows/langfuse_experiment.js';
import type { ConversationHistory } from '../../evals/workflows/types.js';

function makeOutput(overrides: Partial<WorkflowTaskOutput> = {}): WorkflowTaskOutput {
    const conversation: ConversationHistory = {
        userPrompt: 'q',
        turns: [
            {
                turnNumber: 1,
                toolCalls: [],
                toolResults: [
                    { toolName: 'a', success: true, resultBytes: 100 },
                    { toolName: 'b', success: true },
                ],
            },
            { turnNumber: 2, toolCalls: [], toolResults: [{ toolName: 'c', success: true, resultBytes: 25 }] },
        ],
        completed: true,
        hitMaxTurns: false,
        totalTurns: 2,
        totalTokens: 1234,
    };
    return {
        id: 'search-001',
        conversation,
        judgeResult: { verdict: 'PASS', reason: 'looks good', rawResponse: '' },
        ...overrides,
    };
}

/** An item result as the SDK hands it to the run gate. */
function makeScoredItem(output: WorkflowTaskOutput, judgeValue: number) {
    return { output, evaluations: [{ name: 'workflow_judge', value: judgeValue }] };
}

describe('evaluators', () => {
    it('scores workflow_judge 1 with the judge reason as comment on PASS', async () => {
        expect(await evaluators[0]({ output: makeOutput() })).toEqual({
            name: 'workflow_judge',
            value: 1,
            comment: 'looks good',
        });
    });

    it('scores workflow_judge 0 on FAIL', async () => {
        const output = makeOutput({ judgeResult: { verdict: 'FAIL', reason: 'missed X', rawResponse: '' } });
        expect(await evaluators[0]({ output })).toEqual({ name: 'workflow_judge', value: 0, comment: 'missed X' });
    });

    it('reports the conversation token total, defaulting to 0 when unmeasured', async () => {
        expect(await evaluators[1]({ output: makeOutput() })).toEqual({ name: 'total_tokens', value: 1234 });

        const output = makeOutput();
        output.conversation.totalTokens = undefined;
        expect(await evaluators[1]({ output })).toEqual({ name: 'total_tokens', value: 0 });
    });

    it('sums tool-result bytes across all turns, treating missing sizes as 0', async () => {
        expect(await evaluators[2]({ output: makeOutput() })).toEqual({ name: 'result_bytes', value: 125 });
    });
});

describe('buildRunSummary()', () => {
    it('exits 0 when every requested item ran and passed', () => {
        const itemResults = [makeScoredItem(makeOutput({ id: 'a' }), 1), makeScoredItem(makeOutput({ id: 'b' }), 1)];
        expect(buildRunSummary(['a', 'b'], itemResults)).toEqual({
            passedCount: 2,
            failures: [],
            droppedIds: [],
            exitCode: 0,
        });
    });

    it('exits 1 and names the failure when an item scored 0', () => {
        const failing = makeOutput({ id: 'b', judgeResult: { verdict: 'FAIL', reason: 'missed X', rawResponse: '' } });
        const summary = buildRunSummary(
            ['a', 'b'],
            [makeScoredItem(makeOutput({ id: 'a' }), 1), makeScoredItem(failing, 0)],
        );
        expect(summary.passedCount).toBe(1);
        expect(summary.failures).toEqual([{ id: 'b', reason: 'missed X' }]);
        expect(summary.exitCode).toBe(1);
    });

    it('exits 1 when the SDK dropped an item, instead of shrinking the denominator', () => {
        const summary = buildRunSummary(['a', 'b', 'c'], [makeScoredItem(makeOutput({ id: 'a' }), 1)]);
        expect(summary.passedCount).toBe(1);
        expect(summary.droppedIds).toEqual(['b', 'c']);
        expect(summary.exitCode).toBe(1);
    });

    it('exits 1 when nothing ran at all', () => {
        expect(buildRunSummary(['a'], []).exitCode).toBe(1);
        expect(buildRunSummary([], []).exitCode).toBe(1);
    });

    it('treats a missing workflow_judge score as a failure, without quoting the stale judge reason', () => {
        const summary = buildRunSummary(['a'], [{ output: makeOutput({ id: 'a' }), evaluations: [] }]);
        expect(summary.passedCount).toBe(0);
        expect(summary.exitCode).toBe(1);
        expect(summary.failures).toEqual([{ id: 'a', reason: 'no workflow_judge score (the evaluator threw)' }]);
    });
});
