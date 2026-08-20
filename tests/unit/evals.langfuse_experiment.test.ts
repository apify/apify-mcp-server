import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    buildDimensionRunScores,
    buildRunSummary,
    countPassed,
    evaluators,
    formatRubricGlyphs,
    makeTask,
    type WorkflowTaskOutput,
} from '../../evals/workflows/langfuse_experiment.js';
import type { LlmClient } from '../../evals/workflows/llm_client.js';
import type * as workflowJudge from '../../evals/workflows/workflow_judge.js';
import type { JudgeResult, RubricResult } from '../../evals/workflows/workflow_judge.js';

// The task runs the Claude Agent SDK, which would otherwise spawn the real agent + server.
const mocks = vi.hoisted(() => ({
    runAgentConversation: vi.fn(async (): Promise<unknown> => {
        throw new Error('spawn ENOENT');
    }),
    emitObservations: vi.fn(),
    evaluateConversation: vi.fn(async () => makeJudgeResult()),
}));

vi.mock('../../evals/workflows/claude_agent.js', () => ({
    runAgentConversation: mocks.runAgentConversation,
}));

vi.mock('../../evals/workflows/langfuse_observations.js', () => ({
    buildAgentObservations: () => ({}),
    emitObservations: mocks.emitObservations,
}));

// Only the judge call is mocked: DIMENSIONS and the rubric shape come from the real module.
vi.mock('../../evals/workflows/workflow_judge.js', async (importOriginal) => ({
    ...(await importOriginal<typeof workflowJudge>()),
    evaluateConversation: mocks.evaluateConversation,
}));

/** A rubric where every dimension passed, unless a dimension is overridden. */
function makeRubric(overrides: Partial<RubricResult> = {}): RubricResult {
    const passing = { verdict: 'PASS' as const, reason: 'looks good' };
    return {
        toolSelection: passing,
        argumentCorrectness: passing,
        resultUtilization: passing,
        taskCompletion: passing,
        errorRecovery: passing,
        planEfficiency: passing,
        ...overrides,
    };
}

function makeJudgeResult(rubric: RubricResult = makeRubric()): JudgeResult {
    return {
        overallVerdict: rubric.taskCompletion.verdict,
        rubric,
        toolSelectionCheck: { checked: false, verdict: null, expected: [], actual: [] },
        rawResponse: '',
    };
}

function makeOutput(overrides: Partial<WorkflowTaskOutput> = {}): WorkflowTaskOutput {
    return {
        id: 'search-001',
        judgeResult: makeJudgeResult(),
        totalTokens: 1234,
        transcript: [],
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
        const judgeResult = makeJudgeResult(makeRubric({ taskCompletion: { verdict: 'FAIL', reason: 'missed X' } }));
        expect(await evaluators[0]({ output: makeOutput({ judgeResult }) })).toEqual({
            name: 'workflow_judge',
            value: 0,
            comment: 'missed X',
        });
    });

    it('scores every rubric dimension separately', async () => {
        const judgeResult = makeJudgeResult(
            makeRubric({ resultUtilization: { verdict: 'FAIL', reason: 'ignored the error' } }),
        );
        expect(await evaluators[1]({ output: makeOutput({ judgeResult }) })).toEqual([
            { name: 'rubric_tool_selection', value: 1, comment: 'looks good' },
            { name: 'rubric_argument_correctness', value: 1, comment: 'looks good' },
            { name: 'rubric_result_utilization', value: 0, comment: 'ignored the error' },
            { name: 'rubric_task_completion', value: 1, comment: 'looks good' },
            { name: 'rubric_error_recovery', value: 1, comment: 'looks good' },
            { name: 'rubric_plan_efficiency', value: 1, comment: 'looks good' },
        ]);
    });

    it('reports the conversation token total', async () => {
        expect(await evaluators[2]({ output: makeOutput() })).toEqual([{ name: 'total_tokens', value: 1234 }]);
    });

    it('emits no token score when the provider never reported usage', async () => {
        expect(await evaluators[2]({ output: makeOutput({ totalTokens: undefined }) })).toEqual([]);
    });
});

describe('makeTask()', () => {
    const makeItem = () => ({
        id: 'search-001',
        input: { query: 'q' },
        expectedOutput: 'r',
        metadata: { category: 'search' },
    });

    const makeWorkflowTask = () =>
        makeTask({
            llmClient: {} as LlmClient,
            apifyToken: 'token',
            agentModel: 'agent',
            judgeModel: 'judge',
            toolTimeout: 1,
            mcpToolsOnly: false,
        });

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.runAgentConversation.mockRejectedValue(new Error('spawn ENOENT'));
    });

    it('names the item in a harness error, which the SDK log line omits', async () => {
        await expect(makeWorkflowTask()(makeItem())).rejects.toThrow('Item "search-001": spawn ENOENT');
    });

    it('still scores the item when emitting the agent trace throws', async () => {
        mocks.runAgentConversation.mockResolvedValue({
            conversation: { turns: [], totalTokens: 1234 },
            transcript: [],
        });
        mocks.emitObservations.mockImplementation(() => {
            throw new Error('span export failed');
        });
        vi.spyOn(console, 'error').mockImplementation(() => {});

        await expect(makeWorkflowTask()(makeItem())).resolves.toMatchObject({
            id: 'search-001',
            judgeResult: { overallVerdict: 'PASS' },
            totalTokens: 1234,
        });
    });
});

describe('buildRunSummary()', () => {
    it('counts every requested item that passed', () => {
        expect(buildRunSummary(['a', 'b'], [makeScoredItem('a', 1), makeScoredItem('b', 1)])).toMatchObject({
            passedCount: 2,
            failures: [],
            droppedIds: [],
            scoredCount: 2,
        });
    });

    it('names the failure when an item scored 0', () => {
        const failing = {
            judgeResult: makeJudgeResult(makeRubric({ taskCompletion: { verdict: 'FAIL', reason: 'missed X' } })),
        };
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
        expect(buildRunSummary(['a'], [])).toMatchObject({
            passedCount: 0,
            failures: [],
            droppedIds: ['a'],
            scoredCount: 0,
        });
    });

    it('counts dimension passes over the items that completed', () => {
        const failing = {
            judgeResult: makeJudgeResult(
                makeRubric({ planEfficiency: { verdict: 'FAIL', reason: 'four redundant calls' } }),
            ),
        };
        const summary = buildRunSummary(['a', 'b'], [makeScoredItem('a', 1), makeScoredItem('b', 1, failing)]);
        expect(summary.dimensionPassCounts).toEqual({
            toolSelection: 2,
            argumentCorrectness: 2,
            resultUtilization: 2,
            taskCompletion: 2,
            errorRecovery: 2,
            planEfficiency: 1,
        });
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

describe('buildDimensionRunScores()', () => {
    it('divides dimension passes by the requested count, not the completed count', () => {
        const scores = buildDimensionRunScores(4, [makeScoredItem('a', 1), makeScoredItem('b', 1)]);
        expect(scores).toContainEqual({ name: 'pass_rate_tool_selection', value: 0.5 });
        expect(scores).toHaveLength(6);
    });
});

describe('formatRubricGlyphs()', () => {
    it('renders the six verdicts in a fixed order', () => {
        const rubric = makeRubric({ resultUtilization: { verdict: 'FAIL', reason: 'misreported' } });
        expect(formatRubricGlyphs(rubric)).toBe('tool✓ args✓ result✗ complete✓ recover✓ eff✓');
    });
});
