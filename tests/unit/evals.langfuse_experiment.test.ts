import { describe, expect, it, vi } from 'vitest';

import {
    buildRunSummary,
    countPassed,
    evaluators,
    makeTask,
    type WorkflowTaskOutput,
} from '../../evals/workflows/langfuse_experiment.js';
import type { LlmClient } from '../../evals/workflows/llm_client.js';

// The task builds its own McpClient, which would otherwise spawn the real server.
vi.mock('../../evals/workflows/mcp_client.js', () => ({
    McpClient: class {
        async start(): Promise<void> {
            throw new Error('spawn ENOENT');
        }

        async cleanup(): Promise<void> {}
    },
}));

function makeOutput(overrides: Partial<WorkflowTaskOutput> = {}): WorkflowTaskOutput {
    return {
        id: 'search-001',
        judgeResult: { verdict: 'PASS', reason: 'looks good', rawResponse: '' },
        totalTokens: 1234,
        ...overrides,
    };
}

/** An item result as the SDK hands it to the run gate. */
function makeScoredItem(id: string, judgeValue: number, output: Partial<WorkflowTaskOutput> = {}) {
    return { output: makeOutput({ id, ...output }), evaluations: [{ name: 'workflow_judge', value: judgeValue }] };
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

    it('reports the conversation token total', async () => {
        expect(await evaluators[1]({ output: makeOutput() })).toEqual([{ name: 'total_tokens', value: 1234 }]);
    });

    it('emits no token score when the provider never reported usage', async () => {
        expect(await evaluators[1]({ output: makeOutput({ totalTokens: undefined }) })).toEqual([]);
    });
});

describe('makeTask()', () => {
    it('names the item in a harness error, which the SDK log line omits', async () => {
        const task = makeTask({
            llmClient: {} as LlmClient,
            apifyToken: 'token',
            agentModel: 'agent',
            judgeModel: 'judge',
            toolTimeout: 1,
        });

        await expect(
            task({ id: 'search-001', input: { query: 'q' }, expectedOutput: 'r', metadata: { category: 'search' } }),
        ).rejects.toThrow('Item "search-001": spawn ENOENT');
    });
});

describe('buildRunSummary()', () => {
    it('counts every requested item that passed', () => {
        expect(buildRunSummary(['a', 'b'], [makeScoredItem('a', 1), makeScoredItem('b', 1)])).toEqual({
            passedCount: 2,
            failures: [],
            droppedIds: [],
        });
    });

    it('names the failure when an item scored 0', () => {
        const failing = { judgeResult: { verdict: 'FAIL' as const, reason: 'missed X', rawResponse: '' } };
        const summary = buildRunSummary(['a', 'b'], [makeScoredItem('a', 1), makeScoredItem('b', 0, failing)]);
        expect(summary.passedCount).toBe(1);
        expect(summary.failures).toEqual([{ id: 'b', reason: 'missed X' }]);
    });

    it('reports items the SDK dropped instead of shrinking the denominator', () => {
        const summary = buildRunSummary(['a', 'b', 'c'], [makeScoredItem('a', 1)]);
        expect(summary.passedCount).toBe(1);
        expect(summary.droppedIds).toEqual(['b', 'c']);
    });

    it('reports every requested id as dropped when nothing ran at all', () => {
        expect(buildRunSummary(['a'], [])).toEqual({ passedCount: 0, failures: [], droppedIds: ['a'] });
    });

    it('treats a missing workflow_judge score as a failure, without quoting the stale judge reason', () => {
        const summary = buildRunSummary(['a'], [{ output: makeOutput({ id: 'a' }), evaluations: [] }]);
        expect(summary.passedCount).toBe(0);
        expect(summary.failures).toEqual([{ id: 'a', reason: 'no workflow_judge score (the evaluator threw)' }]);
    });
});

describe('countPassed()', () => {
    it('counts only items scored 1, ignoring failures and missing scores', () => {
        const itemResults = [
            makeScoredItem('a', 1),
            makeScoredItem('b', 0),
            { output: makeOutput({ id: 'c' }), evaluations: [] },
        ];
        expect(countPassed(itemResults)).toBe(1);
    });
});
