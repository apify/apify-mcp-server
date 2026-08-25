import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    buildRunSummary,
    countPassed,
    evaluators,
    makeTask,
    type McpAgentTaskOutput,
} from '../../evals/mcp_agent/langfuse_experiment.js';
import type { LlmClient } from '../../evals/mcp_agent/llm_client.js';

// The task runs the Claude Agent SDK, which would otherwise spawn the real agent + server.
const mocks = vi.hoisted(() => ({
    runAgentConversation: vi.fn(async (): Promise<unknown> => {
        throw new Error('spawn ENOENT');
    }),
    emitObservations: vi.fn(),
    evaluateConversation: vi.fn(async () => ({ verdict: 'PASS', reason: 'looks good', rawResponse: '' })),
}));

vi.mock('../../evals/mcp_agent/claude_agent.js', () => ({
    runAgentConversation: mocks.runAgentConversation,
}));

vi.mock('../../evals/mcp_agent/langfuse_observations.js', () => ({
    buildAgentObservations: () => ({}),
    emitObservations: mocks.emitObservations,
}));

vi.mock('../../evals/mcp_agent/mcp_agent_judge.js', () => ({
    evaluateConversation: mocks.evaluateConversation,
}));

function makeOutput(overrides: Partial<McpAgentTaskOutput> = {}): McpAgentTaskOutput {
    return {
        id: 'search-001',
        judgeResult: { verdict: 'PASS', reason: 'looks good', rawResponse: '' },
        totalTokens: 1234,
        transcript: [],
        ...overrides,
    };
}

/** An item result as the SDK hands it to the run gate. */
function makeScoredItem(id: string, judgeValue: number, output: Partial<McpAgentTaskOutput> = {}) {
    return { output: makeOutput({ id, ...output }), evaluations: [{ name: 'mcp_agent_judge', value: judgeValue }] };
}

describe('evaluators', () => {
    it('scores mcp_agent_judge 1 with the judge reason as comment on PASS', async () => {
        expect(await evaluators[0]({ output: makeOutput() })).toEqual({
            name: 'mcp_agent_judge',
            value: 1,
            comment: 'looks good',
        });
    });

    it('scores mcp_agent_judge 0 on FAIL', async () => {
        const output = makeOutput({ judgeResult: { verdict: 'FAIL', reason: 'missed X', rawResponse: '' } });
        expect(await evaluators[0]({ output })).toEqual({ name: 'mcp_agent_judge', value: 0, comment: 'missed X' });
    });

    it('reports the conversation token total', async () => {
        expect(await evaluators[1]({ output: makeOutput() })).toEqual([{ name: 'total_tokens', value: 1234 }]);
    });

    it('emits no token score when the provider never reported usage', async () => {
        expect(await evaluators[1]({ output: makeOutput({ totalTokens: undefined }) })).toEqual([]);
    });
});

describe('makeTask()', () => {
    const makeItem = () => ({
        id: 'search-001',
        input: { query: 'q' },
        expectedOutput: 'r',
        metadata: { category: 'search' },
    });

    const makeMcpAgentTask = () =>
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
        await expect(makeMcpAgentTask()(makeItem())).rejects.toThrow('Item "search-001": spawn ENOENT');
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

        await expect(makeMcpAgentTask()(makeItem())).resolves.toMatchObject({
            id: 'search-001',
            judgeResult: { verdict: 'PASS' },
            totalTokens: 1234,
        });
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

    it('treats a missing mcp_agent_judge score as a failure, without quoting the stale judge reason', () => {
        const summary = buildRunSummary(['a'], [{ output: makeOutput({ id: 'a' }), evaluations: [] }]);
        expect(summary.passedCount).toBe(0);
        expect(summary.failures).toEqual([{ id: 'a', reason: 'no mcp_agent_judge score (the evaluator threw)' }]);
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
