import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    buildRunSummary,
    evaluators,
    expandIterations,
    formatRunSummary,
    isTransientAgentError,
    makeTask,
    resolveExitCode,
    validateConcurrency,
    validateIterations,
    validatePassThreshold,
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

function makeAgentOutput(overrides: Partial<Extract<McpAgentTaskOutput, { kind: 'agent' }>> = {}) {
    return {
        kind: 'agent' as const,
        id: 'search-001',
        judgeResult: { verdict: 'PASS' as const, reason: 'looks good', rawResponse: '' },
        totalTokens: 1234,
        transcript: [],
        toolErrors: [],
        ...overrides,
    };
}

function makeToolCallOutput(overrides: Partial<Extract<McpAgentTaskOutput, { kind: 'tool-call' }>> = {}) {
    return {
        kind: 'tool-call' as const,
        id: 'search-001',
        firstToolMatch: { isMatch: true, comment: 'search-actors({}) — matched expectedTools [search-actors]' },
        ...overrides,
    };
}

function makeAgentRun(overrides: Record<string, unknown> = {}) {
    return {
        conversation: { turns: [], totalTokens: 1234 },
        transcript: [],
        toolInvocations: [],
        attemptedCalls: [],
        ...overrides,
    };
}

/** An agent item result as the SDK hands it to the run gate. */
function makeScoredAgentItem(
    id: string,
    judgeValue: number,
    output: Partial<Extract<McpAgentTaskOutput, { kind: 'agent' }>> = {},
) {
    return {
        output: makeAgentOutput({ id, ...output }),
        evaluations: [{ name: 'mcp_agent_judge', value: judgeValue }],
    };
}

/** A tool-call item result as the SDK hands it to the run gate. */
function makeScoredToolCallItem(
    id: string,
    matchValue: number,
    output: Partial<Extract<McpAgentTaskOutput, { kind: 'tool-call' }>> = {},
) {
    return {
        output: makeToolCallOutput({ id, ...output }),
        evaluations: [{ name: 'first_tool_match', value: matchValue }],
    };
}

describe('evaluators', () => {
    it('scores mcp_agent_judge 1 with the judge reason as comment on PASS', async () => {
        expect(await evaluators[0]({ output: makeAgentOutput() })).toEqual({
            name: 'mcp_agent_judge',
            value: 1,
            comment: 'looks good',
        });
    });

    it('scores mcp_agent_judge 0 on FAIL', async () => {
        const output = makeAgentOutput({ judgeResult: { verdict: 'FAIL', reason: 'missed X', rawResponse: '' } });
        expect(await evaluators[0]({ output })).toEqual({ name: 'mcp_agent_judge', value: 0, comment: 'missed X' });
    });

    it('emits only kind-appropriate scores', async () => {
        expect(await evaluators[0]({ output: makeToolCallOutput() })).toEqual([]);
        expect(await evaluators[1]({ output: makeToolCallOutput() })).toEqual([]);
        expect(await evaluators[2]({ output: makeToolCallOutput() })).toEqual([]);
        expect(await evaluators[3]({ output: makeAgentOutput() })).toEqual([]);
    });

    it('reports the conversation token total', async () => {
        expect(await evaluators[1]({ output: makeAgentOutput() })).toEqual([{ name: 'total_tokens', value: 1234 }]);
    });

    it('emits no token score when the provider never reported usage', async () => {
        expect(await evaluators[1]({ output: makeAgentOutput({ totalTokens: undefined }) })).toEqual([]);
    });

    it('scores tool_errors 0 without a comment on a clean item', async () => {
        expect(await evaluators[2]({ output: makeAgentOutput() })).toEqual({ name: 'tool_errors', value: 0 });
    });

    it('counts only unexpected failures in tool_errors, marking expected ones in the comment', async () => {
        const output = makeAgentOutput({
            toolErrors: [
                { tool: 'get-actor-task', error: 'task not found', expected: true },
                { tool: 'create-actor-task', error: 'name taken', expected: false },
            ],
        });
        expect(await evaluators[2]({ output })).toEqual({
            name: 'tool_errors',
            value: 1,
            comment: 'get-actor-task: task not found (expected)\ncreate-actor-task: name taken',
        });
    });

    it('scores tool_errors 0 when the only failure is exempted by expectedErrors', async () => {
        const output = makeAgentOutput({
            toolErrors: [{ tool: 'get-actor-task', error: 'task not found', expected: true }],
        });
        expect(await evaluators[2]({ output })).toEqual({
            name: 'tool_errors',
            value: 0,
            comment: 'get-actor-task: task not found (expected)',
        });
    });

    it('scores first_tool_match 1 with the match comment on a tool-call pass', async () => {
        expect(await evaluators[3]({ output: makeToolCallOutput() })).toEqual({
            name: 'first_tool_match',
            value: 1,
            comment: 'search-actors({}) — matched expectedTools [search-actors]',
        });
    });

    it('scores first_tool_match 0 on a tool-call mismatch', async () => {
        const output = makeToolCallOutput({
            firstToolMatch: { isMatch: false, comment: 'no tool call attempted' },
        });
        expect(await evaluators[3]({ output })).toEqual({
            name: 'first_tool_match',
            value: 0,
            comment: 'no tool call attempted',
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
        metadata: { category: 'search', kind: 'agent', tier: ['merge'] },
        ...overrides,
    });

    const makeToolCallItem = (overrides: Record<string, unknown> = {}) => ({
        id: 'search-001',
        input: { query: 'q' },
        metadata: { category: 'search', kind: 'tool-call', tier: ['pr'], expectedTools: ['search-actors'] },
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
            totalTrials: 1,
        });

    beforeEach(() => {
        vi.clearAllMocks();
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'log').mockImplementation(() => {});
        mocks.runAgentConversation.mockRejectedValue(new Error('spawn ENOENT'));
    });

    it('names the item and does not retry on a deterministic failure', async () => {
        await expect(makeMcpAgentTask()(makeItem())).rejects.toThrow('Item "search-001": spawn ENOENT');
        expect(mocks.runAgentConversation).toHaveBeenCalledTimes(1);
    });

    it('rethrows a transient failure that persists across the retry', async () => {
        mocks.runAgentConversation.mockRejectedValue(new Error('Connection error.'));
        await expect(makeMcpAgentTask()(makeItem())).rejects.toThrow('Item "search-001": Connection error.');
        expect(mocks.runAgentConversation).toHaveBeenCalledTimes(2);
    });

    it('retries the agent run once on a transient failure', async () => {
        mocks.runAgentConversation
            .mockRejectedValueOnce(new Error('Connection error.'))
            .mockResolvedValueOnce(makeAgentRun());

        await expect(makeMcpAgentTask()(makeItem())).resolves.toMatchObject({
            id: 'search-001',
            judgeResult: { verdict: 'PASS' },
        });
        expect(mocks.runAgentConversation).toHaveBeenCalledTimes(2);
    });

    it('still scores the item when emitting the agent trace throws', async () => {
        mocks.runAgentConversation.mockResolvedValue(makeAgentRun());
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
        mocks.runAgentConversation.mockResolvedValue(
            makeAgentRun({
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
            }),
        );
        const item = makeItem({
            metadata: { category: 'search', kind: 'agent', tier: ['merge'], failTools: ['call-actor'] },
        });

        // First line only: the full text already sits on the tool span, so nothing re-uploads it.
        await expect(makeMcpAgentTask()(item)).resolves.toMatchObject({
            toolErrors: [{ tool: 'create-actor-task', error: 'name taken', expected: false }],
        });
    });

    it('marks a tool failure named in expectedErrors as expected, without exempting it from the list', async () => {
        mocks.runAgentConversation.mockResolvedValue(
            makeAgentRun({
                toolInvocations: [
                    { name: 'get-actor-task', isMcpTool: true, result: { success: false, error: 'task not found' } },
                    { name: 'create-actor-task', isMcpTool: true, result: { success: false, error: 'name taken' } },
                ],
            }),
        );
        const item = makeItem({
            metadata: { category: 'get', kind: 'agent', tier: ['merge'], expectedErrors: ['get-actor-task'] },
        });

        await expect(makeMcpAgentTask()(item)).resolves.toMatchObject({
            toolErrors: [
                { tool: 'get-actor-task', error: 'task not found', expected: true },
                { tool: 'create-actor-task', error: 'name taken', expected: false },
            ],
        });
    });

    it('runs a kind: tool-call item under isToolCallMode, scoring first_tool_match with no judge call', async () => {
        mocks.runAgentConversation.mockResolvedValue(
            makeAgentRun({
                conversation: { turns: [], totalTokens: undefined },
                attemptedCalls: [{ toolName: 'mcp__apify__search-actors', input: { keywords: 'tiktok' } }],
            }),
        );

        const result = await makeMcpAgentTask()(makeToolCallItem());

        expect(result).toMatchObject({
            kind: 'tool-call',
            id: 'search-001',
            firstToolMatch: { isMatch: true },
        });
        expect(mocks.evaluateConversation).not.toHaveBeenCalled();
        expect(mocks.runAgentConversation).toHaveBeenCalledWith(expect.objectContaining({ isToolCallMode: true }));
    });

    it('carries the run-wide mcpToolsOnly OR the per-item mcpToolsOnly into the tool-call run', async () => {
        mocks.runAgentConversation.mockResolvedValue(makeAgentRun());
        const item = makeToolCallItem({
            metadata: {
                category: 'search',
                kind: 'tool-call',
                tier: ['pr'],
                expectedTools: ['search-actors'],
                mcpToolsOnly: true,
            },
        });

        await makeMcpAgentTask()(item);
        expect(mocks.runAgentConversation).toHaveBeenCalledWith(expect.objectContaining({ mcpToolsOnly: true }));
    });

    it('applies the run-wide mcpToolsOnly to an item that does not set its own flag', async () => {
        mocks.runAgentConversation.mockResolvedValue(makeAgentRun());
        const task = makeTask({
            llmClient: {} as LlmClient,
            apifyToken: 'token',
            agentModel: 'agent',
            judgeModel: 'judge',
            toolTimeout: 1,
            mcpToolsOnly: true,
            totalTrials: 1,
        });

        await task(makeToolCallItem());
        expect(mocks.runAgentConversation).toHaveBeenCalledWith(expect.objectContaining({ mcpToolsOnly: true }));
    });

    it('carries a runner-injected iteration through to the output', async () => {
        mocks.runAgentConversation.mockResolvedValue(makeAgentRun());
        const item = makeItem({ metadata: { category: 'search', kind: 'agent', tier: ['merge'], iteration: 2 } });

        await expect(makeMcpAgentTask()(item)).resolves.toMatchObject({ iteration: 2 });
    });
});

describe('buildRunSummary()', () => {
    it('counts every requested item that passed', () => {
        const summary = buildRunSummary(['a', 'b'], [makeScoredAgentItem('a', 1), makeScoredAgentItem('b', 1)], 1);
        expect(summary).toMatchObject({
            passedTrials: 2,
            requestedTrials: 2,
            passRate: 1,
            failures: [],
            droppedTrials: [],
        });
    });

    it('names the failure when an item scored 0', () => {
        const failing = { judgeResult: { verdict: 'FAIL' as const, reason: 'missed X', rawResponse: '' } };
        const summary = buildRunSummary(
            ['a', 'b'],
            [makeScoredAgentItem('a', 1), makeScoredAgentItem('b', 0, failing)],
            1,
        );
        expect(summary.passedTrials).toBe(1);
        expect(summary.failures).toEqual([{ id: 'b', iteration: 1, reason: 'missed X' }]);
    });

    it('fails a judge-passing item on an unexpected tool error, naming the calls', () => {
        const errored = { toolErrors: [{ tool: 'create-actor-task', error: 'name taken', expected: false }] };
        const summary = buildRunSummary(['a'], [makeScoredAgentItem('a', 1, errored)], 1);
        expect(summary.passedTrials).toBe(0);
        expect(summary.failures).toEqual([
            {
                id: 'a',
                iteration: 1,
                reason: 'judge passed, but 1 unexpected tool error(s): create-actor-task: name taken',
            },
        ]);
    });

    it('passes a judge-passing item whose only tool error is expected', () => {
        const errored = { toolErrors: [{ tool: 'get-actor-task', error: 'not found', expected: true }] };
        const summary = buildRunSummary(['a'], [makeScoredAgentItem('a', 1, errored)], 1);
        expect(summary.passedTrials).toBe(1);
        expect(summary.failures).toEqual([]);
    });

    it('scores a tool-call item on first_tool_match alone', () => {
        expect(buildRunSummary(['a'], [makeScoredToolCallItem('a', 1)], 1).passedTrials).toBe(1);
    });

    it('names a tool-call mismatch failure with the first_tool_match comment', () => {
        const output = makeToolCallOutput({
            id: 'a',
            firstToolMatch: { isMatch: false, comment: 'no tool call attempted' },
        });
        const summary = buildRunSummary(['a'], [{ output, evaluations: [{ name: 'first_tool_match', value: 0 }] }], 1);
        expect(summary.failures).toEqual([
            { id: 'a', iteration: 1, reason: 'first_tool_match 0 — no tool call attempted' },
        ]);
    });

    it('reports items the SDK dropped instead of shrinking the denominator', () => {
        const summary = buildRunSummary(['a', 'b', 'c'], [makeScoredAgentItem('a', 1)], 1);
        expect(summary.passedTrials).toBe(1);
        expect(summary.requestedTrials).toBe(3);
        expect(summary.droppedTrials).toEqual([
            { id: 'b', iteration: 1 },
            { id: 'c', iteration: 1 },
        ]);
    });

    it('treats a missing mcp_agent_judge score as a failure, without quoting the stale judge reason', () => {
        const summary = buildRunSummary(['a'], [{ output: makeAgentOutput({ id: 'a' }), evaluations: [] }], 1);
        expect(summary.passedTrials).toBe(0);
        expect(summary.failures).toEqual([
            { id: 'a', iteration: 1, reason: 'no mcp_agent_judge score (the evaluator threw)' },
        ]);
    });

    it('treats a missing first_tool_match score on a tool-call item as a failure', () => {
        const summary = buildRunSummary(['a'], [{ output: makeToolCallOutput({ id: 'a' }), evaluations: [] }], 1);
        expect(summary.passedTrials).toBe(0);
        expect(summary.failures).toEqual([
            { id: 'a', iteration: 1, reason: 'no first_tool_match score (the evaluator threw)' },
        ]);
    });

    describe('with iterations > 1', () => {
        it('groups repeated trials of the same id by metadata.iteration', () => {
            const trial1 = makeScoredAgentItem('a', 1, { iteration: 1 });
            const trial2 = makeScoredAgentItem('a', 1, { iteration: 2 });
            const summary = buildRunSummary(['a'], [trial2, trial1], 2);
            expect(summary.items).toEqual([
                {
                    id: 'a',
                    trials: [
                        { iteration: 1, passed: true },
                        { iteration: 2, passed: true },
                    ],
                },
            ]);
        });

        it('scales the requested-trials denominator by requestedIds.length * iterations', () => {
            const summary = buildRunSummary(['a', 'b'], [makeScoredAgentItem('a', 1, { iteration: 1 })], 2);
            expect(summary.requestedTrials).toBe(4);
            expect(summary.passRate).toBe(0.25);
            expect(summary.droppedTrials).toEqual([
                { id: 'a', iteration: 2 },
                { id: 'b', iteration: 1 },
                { id: 'b', iteration: 2 },
            ]);
        });
    });
});

describe('resolveExitCode()', () => {
    it('compares the pass rate with the threshold', () => {
        const summary = buildRunSummary(
            ['a', 'b', 'c', 'd'],
            [
                makeScoredAgentItem('a', 1),
                makeScoredAgentItem('b', 1),
                makeScoredAgentItem('c', 1),
                makeScoredAgentItem('d', 0, { judgeResult: { verdict: 'FAIL', reason: 'x', rawResponse: '' } }),
            ],
            1,
        );
        expect(summary.passRate).toBe(0.75);
        expect(resolveExitCode(summary, 0.75)).toBe(0);
        expect(resolveExitCode(summary, 0.8)).toBe(1);
    });
});

describe('expandIterations()', () => {
    it('repeats items with an iteration without mutating their metadata', () => {
        const items = [
            { id: 'a', metadata: { category: 'x' } },
            { id: 'b', metadata: { category: 'y' } },
        ] as unknown as Parameters<typeof expandIterations>[0];

        const data = expandIterations(items, 3) as unknown as { id: string; metadata: { iteration: number } }[];

        expect(data).toHaveLength(6);
        const iterationsFor = (id: string) =>
            data.filter((item) => item.id === id).map((item) => item.metadata.iteration);
        expect(iterationsFor('a')).toEqual([1, 2, 3]);
        expect(iterationsFor('b')).toEqual([1, 2, 3]);
        expect(data[0].metadata).toEqual({ category: 'x', iteration: 1 });
        expect(items[0].metadata).toEqual({ category: 'x' });
    });
});

describe('formatRunSummary()', () => {
    it('prints 🔁 per item in iteration order, a ❌ line naming the failed iteration, and 📈 pass@k/pass^k', () => {
        const trial1 = makeScoredAgentItem('a', 1, { iteration: 1 });
        const trial2Fail = makeScoredAgentItem('a', 0, {
            iteration: 2,
            judgeResult: { verdict: 'FAIL' as const, reason: 'missed X', rawResponse: '' },
        });
        const summary = buildRunSummary(['a'], [trial2Fail, trial1], 2);

        const texts = formatRunSummary(summary, 0.8, 2).map((line) => line.text);

        expect(texts[0]).toBe('🔁 a   ✅ ❌   pass@2 ✅  pass^2 ❌');
        expect(texts).toContain('❌ a (iteration 2): missed X');
        expect(texts).toContain('📊 1/2 trials passed (pass_rate 0.50, threshold 0.80)');
        expect(texts).toContain('📈 pass@2 1/1 items · pass^2 0/1 items');
    });
});

describe('validateIterations()', () => {
    it('accepts positive integers and rejects other values', () => {
        expect(() => validateIterations(1)).not.toThrow();
        for (const value of [0, -1, 1.5]) expect(() => validateIterations(value)).toThrow(/positive integer/);
    });
});

describe('validatePassThreshold()', () => {
    it('accepts [0, 1] and rejects values outside it', () => {
        for (const value of [0, 0.8, 1]) expect(() => validatePassThreshold(value)).not.toThrow();
        for (const value of [-0.1, 1.1, NaN]) expect(() => validatePassThreshold(value)).toThrow(/between 0 and 1/);
    });
});

describe('validateConcurrency()', () => {
    it('accepts positive integers and rejects other values', () => {
        expect(() => validateConcurrency(1)).not.toThrow();
        for (const value of [0, -1, 1.5, NaN]) expect(() => validateConcurrency(value)).toThrow(/positive integer/);
    });
});
