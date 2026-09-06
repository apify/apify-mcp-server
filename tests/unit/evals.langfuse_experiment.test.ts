import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    buildRunSummary,
    countPassed,
    evaluators,
    isTransientAgentError,
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
        toolErrors: [],
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

describe('isTransientAgentError()', () => {
    it.each([
        'Connection error.',
        'fetch failed',
        'socket hang up',
        'read ECONNRESET',
        'API error: 529 overloaded_error',
        'Request failed with status 503',
    ])('treats "%s" as transient', (message) => {
        expect(isTransientAgentError(new Error(message))).toBe(true);
    });

    it.each(['spawn ENOENT', 'Prompt is too long', 'stdio binary not found', 'Invalid model name'])(
        'treats "%s" as permanent',
        (message) => {
            expect(isTransientAgentError(new Error(message))).toBe(false);
        },
    );
});

describe('makeTask()', () => {
    const makeItem = (overrides: Record<string, unknown> = {}) => ({
        id: 'search-001',
        input: { query: 'q' },
        expectedOutput: 'r',
        metadata: { category: 'search', kind: 'agent', tier: ['full'] },
        ...overrides,
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
        vi.spyOn(console, 'error').mockImplementation(() => {});
        mocks.runAgentConversation.mockRejectedValue(new Error('spawn ENOENT'));
    });

    it('names the item in a harness error, which the SDK log line omits', async () => {
        await expect(makeMcpAgentTask()(makeItem())).rejects.toThrow('Item "search-001": spawn ENOENT');
    });

    it('does not retry the agent run on a deterministic failure', async () => {
        await expect(makeMcpAgentTask()(makeItem())).rejects.toThrow('spawn ENOENT');
        expect(mocks.runAgentConversation).toHaveBeenCalledTimes(1);
    });

    it('rethrows a transient failure that persists across the retry', async () => {
        mocks.runAgentConversation.mockRejectedValue(new Error('Connection error.'));
        await expect(makeMcpAgentTask()(makeItem())).rejects.toThrow('Item "search-001": Connection error.');
        expect(mocks.runAgentConversation).toHaveBeenCalledTimes(2);
    });

    it('retries the agent run once on a transient failure', async () => {
        mocks.runAgentConversation.mockRejectedValueOnce(new Error('Connection error.')).mockResolvedValueOnce({
            conversation: { turns: [], totalTokens: 1234 },
            transcript: [],
            toolInvocations: [],
        });

        await expect(makeMcpAgentTask()(makeItem())).resolves.toMatchObject({
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

        await expect(makeMcpAgentTask()(makeItem())).resolves.toMatchObject({
            id: 'search-001',
            judgeResult: { verdict: 'PASS' },
            totalTokens: 1234,
        });
    });

    it('collects failed tool calls, exempting built-ins and the ones failTools injected', async () => {
        mocks.runAgentConversation.mockResolvedValue({
            conversation: { turns: [], totalTokens: 1234 },
            transcript: [],
            toolInvocations: [
                { name: 'get-actor-task', isMcpTool: true, result: { success: true, result: 'ok' } },
                {
                    name: 'create-actor-task',
                    isMcpTool: true,
                    result: { success: false, error: 'name taken\nstack line' },
                },
                { name: 'call-actor', isMcpTool: true, result: { success: false, error: 'injected' } },
                // A built-in failing says nothing about the server under test.
                { name: 'Bash', isMcpTool: false, result: { success: false, error: 'exit status 1' } },
            ],
        });
        const item = makeItem({
            metadata: { category: 'search', kind: 'agent', tier: ['full'], failTools: ['call-actor'] },
        });

        // First line only: the full text already sits on the tool span, so nothing re-uploads it.
        await expect(makeMcpAgentTask()(item)).resolves.toMatchObject({
            toolErrors: [{ tool: 'create-actor-task', error: 'name taken' }],
        });
    });

    it('rejects a kind: selection item without spending an agent run', async () => {
        const item = makeItem({
            expectedOutput: undefined,
            metadata: { category: 'search', kind: 'selection', tier: ['full'], expectedTools: ['search-actors'] },
        });

        await expect(makeMcpAgentTask()(item)).rejects.toThrow(
            'Item "search-001": kind "selection" item reached the agent task; this task only runs agent items',
        );
        expect(mocks.runAgentConversation).not.toHaveBeenCalled();
    });

    it('rejects a kind: selection item that also carries an expectedOutput', async () => {
        const item = makeItem({
            expectedOutput: 'a reference the validator does not yet reject on a selection item',
            metadata: { category: 'search', kind: 'selection', tier: ['full'], expectedTools: ['search-actors'] },
        });

        await expect(makeMcpAgentTask()(item)).rejects.toThrow(
            'Item "search-001": kind "selection" item reached the agent task; this task only runs agent items',
        );
        expect(mocks.runAgentConversation).not.toHaveBeenCalled();
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
        const errored = { toolErrors: [{ tool: 'create-actor-task', error: 'name taken' }] };
        const summary = buildRunSummary(['a'], [makeScoredItem('a', 1, errored)], false);
        expect(summary.passedCount).toBe(0);
        expect(summary.failures).toEqual([
            { id: 'a', reason: 'judge passed, but 1 tool error(s): create-actor-task: name taken' },
        ]);
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

    it('treats a missing mcp_agent_judge score as a failure, without quoting the stale judge reason', () => {
        const summary = buildRunSummary(['a'], [{ output: makeOutput({ id: 'a' }), evaluations: [] }], false);
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
        expect(countPassed(itemResults, false)).toBe(1);
    });

    // countPassed is what feeds the run's pass_rate score, so the gate has to hold here too.
    it('counts a judge-passing item with tool errors only when the run allows them', () => {
        const itemResults = [makeScoredItem('a', 1, { toolErrors: [{ tool: 'get-actor-task', error: 'boom' }] })];
        expect(countPassed(itemResults, false)).toBe(0);
        expect(countPassed(itemResults, true)).toBe(1);
    });
});
