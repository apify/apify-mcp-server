import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    buildRunSummary,
    countPassed,
    evaluators,
    makeTask,
    type WorkflowTaskOutput,
} from '../../evals/workflows/langfuse_experiment.js';
import type { LlmClient } from '../../evals/workflows/llm_client.js';

// The task runs the Claude Agent SDK, which would otherwise spawn the real agent + server.
const mocks = vi.hoisted(() => ({
    runAgentConversation: vi.fn(async (): Promise<unknown> => {
        throw new Error('spawn ENOENT');
    }),
    emitObservations: vi.fn(),
    evaluateConversation: vi.fn(async () => ({ verdict: 'PASS', reason: 'looks good', rawResponse: '' })),
}));

vi.mock('../../evals/workflows/claude_agent.js', () => ({
    runAgentConversation: mocks.runAgentConversation,
}));

vi.mock('../../evals/workflows/langfuse_observations.js', () => ({
    buildAgentObservations: () => ({}),
    emitObservations: mocks.emitObservations,
}));

vi.mock('../../evals/workflows/workflow_judge.js', () => ({
    evaluateConversation: mocks.evaluateConversation,
}));

function makeOutput(overrides: Partial<WorkflowTaskOutput> = {}): WorkflowTaskOutput {
    return {
        id: 'search-001',
        judgeResult: { verdict: 'PASS', reason: 'looks good', rawResponse: '' },
        totalTokens: 1234,
        transcript: [],
        toolErrors: [],
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

    it('scores tool_errors 0 without a comment on a clean item', async () => {
        expect(await evaluators[2]({ output: makeOutput() })).toEqual({ name: 'tool_errors', value: 0 });
    });

    it('scores tool_errors with the failing calls in the comment', async () => {
        const output = makeOutput({ toolErrors: [{ tool: 'create-actor-task', error: 'name taken' }] });
        expect(await evaluators[2]({ output })).toEqual({
            name: 'tool_errors',
            value: 1,
            comment: 'create-actor-task: name taken',
        });
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
        vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(makeWorkflowTask()(makeItem())).rejects.toThrow('Item "search-001": spawn ENOENT');
        // Both attempts failed: the transient-failure retry ran and did not mask the error.
        expect(mocks.runAgentConversation).toHaveBeenCalledTimes(2);
    });

    it('retries the agent run once on a transient failure', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        mocks.runAgentConversation.mockRejectedValueOnce(new Error('Connection error.')).mockResolvedValueOnce({
            conversation: { turns: [], totalTokens: 1234 },
            transcript: [],
            toolInvocations: [],
        });

        await expect(makeWorkflowTask()(makeItem())).resolves.toMatchObject({
            id: 'search-001',
            judgeResult: { verdict: 'PASS' },
        });
        expect(mocks.runAgentConversation).toHaveBeenCalledTimes(2);
    });

    it('still scores the item when emitting the agent trace throws', async () => {
        mocks.runAgentConversation.mockResolvedValue({
            conversation: { turns: [], totalTokens: 1234 },
            transcript: [],
            toolInvocations: [],
        });
        mocks.emitObservations.mockImplementation(() => {
            throw new Error('span export failed');
        });
        vi.spyOn(console, 'error').mockImplementation(() => {});

        await expect(makeWorkflowTask()(makeItem())).resolves.toMatchObject({
            id: 'search-001',
            judgeResult: { verdict: 'PASS' },
            totalTokens: 1234,
        });
    });

    it('collects failed tool calls, exempting the ones failTools injected', async () => {
        mocks.runAgentConversation.mockResolvedValue({
            conversation: { turns: [], totalTokens: 1234 },
            transcript: [],
            toolInvocations: [
                { name: 'get-actor-task', result: { success: true, result: 'ok' } },
                { name: 'create-actor-task', result: { success: false, error: 'name taken' } },
                { name: 'call-actor', result: { success: false, error: 'injected' } },
            ],
        });
        const item = { ...makeItem(), metadata: { category: 'search', failTools: ['call-actor'] } };

        await expect(makeWorkflowTask()(item)).resolves.toMatchObject({
            toolErrors: [{ tool: 'create-actor-task', error: 'name taken' }],
        });
    });
});

describe('buildRunSummary()', () => {
    it('counts every requested item that passed', () => {
        expect(buildRunSummary(['a', 'b'], [makeScoredItem('a', 1), makeScoredItem('b', 1)], false)).toEqual({
            passedCount: 2,
            failures: [],
            droppedIds: [],
        });
    });

    it('names the failure when an item scored 0', () => {
        const failing = { judgeResult: { verdict: 'FAIL' as const, reason: 'missed X', rawResponse: '' } };
        const summary = buildRunSummary(['a', 'b'], [makeScoredItem('a', 1), makeScoredItem('b', 0, failing)], false);
        expect(summary.passedCount).toBe(1);
        expect(summary.failures).toEqual([{ id: 'b', reason: 'missed X' }]);
    });

    it('fails a judge-passing item on tool errors under the default gate, naming the calls', () => {
        const errored = { toolErrors: [{ tool: 'create-actor-task', error: 'name taken\ndetails' }] };
        const summary = buildRunSummary(['a'], [makeScoredItem('a', 1, errored)], false);
        expect(summary.passedCount).toBe(0);
        expect(summary.failures).toHaveLength(1);
        expect(summary.failures[0].reason).toContain('1 tool error(s)');
        expect(summary.failures[0].reason).toContain('create-actor-task: name taken');
        expect(summary.failures[0].reason).not.toContain('details');
    });

    it('passes a judge-passing item with tool errors when the run allows them', () => {
        const errored = { toolErrors: [{ tool: 'publish-actor-task', error: 'boom' }] };
        const summary = buildRunSummary(['a'], [makeScoredItem('a', 1, errored)], true);
        expect(summary).toEqual({ passedCount: 1, failures: [], droppedIds: [] });
    });

    it('reports items the SDK dropped instead of shrinking the denominator', () => {
        const summary = buildRunSummary(['a', 'b', 'c'], [makeScoredItem('a', 1)], false);
        expect(summary.passedCount).toBe(1);
        expect(summary.droppedIds).toEqual(['b', 'c']);
    });

    it('reports every requested id as dropped when nothing ran at all', () => {
        expect(buildRunSummary(['a'], [], false)).toEqual({ passedCount: 0, failures: [], droppedIds: ['a'] });
    });

    it('treats a missing workflow_judge score as a failure, without quoting the stale judge reason', () => {
        const summary = buildRunSummary(['a'], [{ output: makeOutput({ id: 'a' }), evaluations: [] }], false);
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
        expect(countPassed(itemResults, false)).toBe(1);
    });

    it('fails items with tool errors unless the run allows them', () => {
        const errored = { toolErrors: [{ tool: 'get-actor-task', error: 'boom' }] };
        const itemResults = [makeScoredItem('a', 1, errored)];
        expect(countPassed(itemResults, false)).toBe(0);
        expect(countPassed(itemResults, true)).toBe(1);
    });
});
