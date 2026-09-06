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

function makeSelectionOutput(overrides: Partial<Extract<McpAgentTaskOutput, { kind: 'selection' }>> = {}) {
    return {
        kind: 'selection' as const,
        id: 'search-001',
        firstToolMatch: { isMatch: true, comment: 'search-actors({}) — matched expectedTools [search-actors]' },
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

/** A selection item result as the SDK hands it to the run gate. */
function makeScoredSelectionItem(
    id: string,
    matchValue: number,
    output: Partial<Extract<McpAgentTaskOutput, { kind: 'selection' }>> = {},
) {
    return {
        output: makeSelectionOutput({ id, ...output }),
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

    it('emits no mcp_agent_judge score for a selection item', async () => {
        expect(await evaluators[0]({ output: makeSelectionOutput() })).toEqual([]);
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

    it('scores tool_errors with the failing calls in the comment', async () => {
        const output = makeAgentOutput({
            toolErrors: [{ tool: 'create-actor-task', error: 'name taken', expected: false }],
        });
        expect(await evaluators[2]({ output })).toEqual({
            name: 'tool_errors',
            value: 1,
            comment: 'create-actor-task: name taken',
        });
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

    it('emits no tool_errors score for a selection item', async () => {
        expect(await evaluators[2]({ output: makeSelectionOutput() })).toEqual([]);
    });

    it('emits no first_tool_match score for an agent item', async () => {
        expect(await evaluators[3]({ output: makeAgentOutput() })).toEqual([]);
    });

    it('scores first_tool_match 1 with the match comment on a selection pass', async () => {
        expect(await evaluators[3]({ output: makeSelectionOutput() })).toEqual({
            name: 'first_tool_match',
            value: 1,
            comment: 'search-actors({}) — matched expectedTools [search-actors]',
        });
    });

    it('scores first_tool_match 0 on a selection mismatch', async () => {
        const output = makeSelectionOutput({
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
        metadata: { category: 'search', kind: 'agent', tier: ['full'] },
        ...overrides,
    });

    const makeSelectionItem = (overrides: Record<string, unknown> = {}) => ({
        id: 'search-001',
        input: { query: 'q' },
        metadata: { category: 'search', kind: 'selection', tier: ['pr'], expectedTools: ['search-actors'] },
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
            attemptedCalls: [],
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
            attemptedCalls: [],
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
            attemptedCalls: [],
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
            toolErrors: [{ tool: 'create-actor-task', error: 'name taken', expected: false }],
        });
    });

    it('marks a tool failure named in expectedErrors as expected, without exempting it from the list', async () => {
        mocks.runAgentConversation.mockResolvedValue({
            conversation: { turns: [], totalTokens: 1234 },
            transcript: [],
            attemptedCalls: [],
            toolInvocations: [
                { name: 'get-actor-task', isMcpTool: true, result: { success: false, error: 'task not found' } },
                { name: 'create-actor-task', isMcpTool: true, result: { success: false, error: 'name taken' } },
            ],
        });
        const item = makeItem({
            metadata: { category: 'get', kind: 'agent', tier: ['full'], expectedErrors: ['get-actor-task'] },
        });

        await expect(makeMcpAgentTask()(item)).resolves.toMatchObject({
            toolErrors: [
                { tool: 'get-actor-task', error: 'task not found', expected: true },
                { tool: 'create-actor-task', error: 'name taken', expected: false },
            ],
        });
    });

    it('runs a kind: selection item under isSelectionMode, scoring first_tool_match with no judge call', async () => {
        mocks.runAgentConversation.mockResolvedValue({
            conversation: { turns: [], totalTokens: undefined },
            transcript: [],
            toolInvocations: [],
            attemptedCalls: [{ toolName: 'mcp__apify__search-actors', input: { keywords: 'tiktok' } }],
        });

        const result = await makeMcpAgentTask()(makeSelectionItem());

        expect(result).toMatchObject({
            kind: 'selection',
            id: 'search-001',
            firstToolMatch: { isMatch: true },
        });
        expect(mocks.evaluateConversation).not.toHaveBeenCalled();
        expect(mocks.runAgentConversation).toHaveBeenCalledWith(expect.objectContaining({ isSelectionMode: true }));
    });

    it('carries the run-wide mcpToolsOnly OR the per-item mcpToolsOnly into the selection run', async () => {
        mocks.runAgentConversation.mockResolvedValue({
            conversation: { turns: [], totalTokens: undefined },
            transcript: [],
            toolInvocations: [],
            attemptedCalls: [],
        });
        const item = makeSelectionItem({
            metadata: {
                category: 'search',
                kind: 'selection',
                tier: ['pr'],
                expectedTools: ['search-actors'],
                mcpToolsOnly: true,
            },
        });

        await makeMcpAgentTask()(item);
        expect(mocks.runAgentConversation).toHaveBeenCalledWith(expect.objectContaining({ mcpToolsOnly: true }));
    });

    it('applies the run-wide mcpToolsOnly to an item that does not set its own flag', async () => {
        mocks.runAgentConversation.mockResolvedValue({
            conversation: { turns: [], totalTokens: undefined },
            transcript: [],
            toolInvocations: [],
            attemptedCalls: [],
        });
        const task = makeTask({
            llmClient: {} as LlmClient,
            apifyToken: 'token',
            agentModel: 'agent',
            judgeModel: 'judge',
            toolTimeout: 1,
            mcpToolsOnly: true,
        });

        await task(makeSelectionItem());
        expect(mocks.runAgentConversation).toHaveBeenCalledWith(expect.objectContaining({ mcpToolsOnly: true }));
    });

    it('retries a kind: selection item once on a transient failure, scoring off the second attempt only', async () => {
        mocks.runAgentConversation.mockRejectedValueOnce(new Error('Connection error.')).mockResolvedValueOnce({
            conversation: { turns: [], totalTokens: undefined },
            transcript: [],
            toolInvocations: [],
            attemptedCalls: [{ toolName: 'mcp__apify__search-actors', input: { keywords: 'tiktok' } }],
        });

        const result = await makeMcpAgentTask()(makeSelectionItem());

        expect(mocks.runAgentConversation).toHaveBeenCalledTimes(2);
        expect(result).toMatchObject({
            kind: 'selection',
            firstToolMatch: {
                isMatch: true,
                comment: 'search-actors({"keywords":"tiktok"}) — matched expectedTools [search-actors]',
            },
        });
    });

    it('carries a runner-injected iteration through to the output', async () => {
        mocks.runAgentConversation.mockResolvedValue({
            conversation: { turns: [], totalTokens: 1234 },
            transcript: [],
            toolInvocations: [],
            attemptedCalls: [],
        });
        const item = makeItem({ metadata: { category: 'search', kind: 'agent', tier: ['full'], iteration: 2 } });

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

    it('scores a selection item on first_tool_match alone', () => {
        expect(buildRunSummary(['a'], [makeScoredSelectionItem('a', 1)], 1).passedTrials).toBe(1);
    });

    it('names a selection mismatch failure with the first_tool_match comment', () => {
        const output = makeSelectionOutput({
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

    it('reports every requested id as dropped when nothing ran at all', () => {
        const summary = buildRunSummary(['a'], [], 1);
        expect(summary).toMatchObject({
            passedTrials: 0,
            requestedTrials: 1,
            droppedTrials: [{ id: 'a', iteration: 1 }],
        });
    });

    it('treats a missing mcp_agent_judge score as a failure, without quoting the stale judge reason', () => {
        const summary = buildRunSummary(['a'], [{ output: makeAgentOutput({ id: 'a' }), evaluations: [] }], 1);
        expect(summary.passedTrials).toBe(0);
        expect(summary.failures).toEqual([
            { id: 'a', iteration: 1, reason: 'no mcp_agent_judge score (the evaluator threw)' },
        ]);
    });

    it('treats a missing first_tool_match score on a selection item as a failure', () => {
        const summary = buildRunSummary(['a'], [{ output: makeSelectionOutput({ id: 'a' }), evaluations: [] }], 1);
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
                    anyPassed: true,
                    allPassed: true,
                },
            ]);
        });

        it('computes pass@k (any trial passed) and pass^k (every trial passed) per item', () => {
            const passFail = { judgeResult: { verdict: 'FAIL' as const, reason: 'x', rawResponse: '' } };
            const itemResults = [
                makeScoredAgentItem('a', 1, { iteration: 1 }),
                makeScoredAgentItem('a', 1, { iteration: 2 }),
                makeScoredAgentItem('b', 1, { iteration: 1 }),
                makeScoredAgentItem('b', 0, { iteration: 2, ...passFail }),
            ];
            const summary = buildRunSummary(['a', 'b'], itemResults, 2);
            expect(summary.passAtK).toBe(2); // both items had at least one pass
            expect(summary.passHatK).toBe(1); // only "a" passed every trial
        });

        it('carries anyPassed/allPassed on each item, matching the passAtK/passHatK aggregates', () => {
            const passFail = { judgeResult: { verdict: 'FAIL' as const, reason: 'x', rawResponse: '' } };
            const itemResults = [
                makeScoredAgentItem('a', 1, { iteration: 1 }),
                makeScoredAgentItem('a', 1, { iteration: 2 }),
                makeScoredAgentItem('b', 1, { iteration: 1 }),
                makeScoredAgentItem('b', 0, { iteration: 2, ...passFail }),
            ];
            const summary = buildRunSummary(['a', 'b'], itemResults, 2);
            expect(summary.items).toEqual([
                {
                    id: 'a',
                    trials: [
                        { iteration: 1, passed: true },
                        { iteration: 2, passed: true },
                    ],
                    anyPassed: true,
                    allPassed: true,
                },
                {
                    id: 'b',
                    trials: [
                        { iteration: 1, passed: true },
                        { iteration: 2, passed: false },
                    ],
                    anyPassed: true,
                    allPassed: false,
                },
            ]);
            // The per-item flags are what the aggregates count, so assert the pair here too.
            expect(summary.passAtK).toBe(summary.items.filter((entry) => entry.anyPassed).length);
            expect(summary.passHatK).toBe(summary.items.filter((entry) => entry.allPassed).length);
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
    it('exits 0 when the pass rate exactly meets the threshold', () => {
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
    });

    it('exits 1 when the pass rate falls one trial short of the threshold', () => {
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
        expect(resolveExitCode(summary, 0.8)).toBe(1);
    });

    it('defaults to strict all-pass semantics at threshold 1.0', () => {
        const allPass = buildRunSummary(['a', 'b'], [makeScoredAgentItem('a', 1), makeScoredAgentItem('b', 1)], 1);
        expect(resolveExitCode(allPass, 1.0)).toBe(0);

        const oneFailed = buildRunSummary(
            ['a', 'b'],
            [
                makeScoredAgentItem('a', 1),
                makeScoredAgentItem('b', 0, { judgeResult: { verdict: 'FAIL', reason: 'x', rawResponse: '' } }),
            ],
            1,
        );
        expect(resolveExitCode(oneFailed, 1.0)).toBe(1);
    });
});

describe('expandIterations()', () => {
    it('repeats each item N times, tagging metadata.iteration 1..N', () => {
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
    });

    it('carries the item metadata through alongside the injected iteration', () => {
        const items = [{ id: 'a', metadata: { category: 'x' } }] as unknown as Parameters<typeof expandIterations>[0];
        const data = expandIterations(items, 1) as unknown as { metadata: { category: string; iteration: number } }[];
        expect(data[0].metadata).toEqual({ category: 'x', iteration: 1 });
    });

    it('does not mutate the source item', () => {
        const source = { id: 'a', metadata: { category: 'x' } };
        const items = [source] as unknown as Parameters<typeof expandIterations>[0];
        expandIterations(items, 2);
        expect(source.metadata).toEqual({ category: 'x' });
    });
});

describe('formatRunSummary()', () => {
    it('omits the 🔁 and 📈 lines when iterations is 1, but shows the threshold in 📊', () => {
        const summary = buildRunSummary(['a', 'b'], [makeScoredAgentItem('a', 1), makeScoredAgentItem('b', 1)], 1);
        const lines = formatRunSummary(summary, 1, 1);
        const texts = lines.map((line) => line.text);

        expect(texts.some((text) => text.startsWith('🔁'))).toBe(false);
        expect(texts.some((text) => text.startsWith('📈'))).toBe(false);
        expect(texts).toContain('📊 2/2 trials passed (pass_rate 1.00, threshold 1.00)');
    });

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

    it('routes the dropped-trial line to the error stream', () => {
        const summary = buildRunSummary(['a', 'b'], [makeScoredAgentItem('a', 1)], 1);
        const dropped = formatRunSummary(summary, 1, 1).find((line) => line.text.startsWith('🔥'));
        expect(dropped).toEqual({ stream: 'error', text: '🔥 Never completed (task threw, see errors above): b' });
    });
});

describe('validateIterations()', () => {
    it('accepts a positive integer', () => {
        expect(() => validateIterations(1)).not.toThrow();
        expect(() => validateIterations(5)).not.toThrow();
    });

    it('rejects zero, negative, and non-integer values', () => {
        expect(() => validateIterations(0)).toThrow('--iterations must be a positive integer, got "0"');
        expect(() => validateIterations(-1)).toThrow('--iterations must be a positive integer');
        expect(() => validateIterations(1.5)).toThrow('--iterations must be a positive integer');
    });
});

describe('validatePassThreshold()', () => {
    it('accepts values within [0, 1]', () => {
        expect(() => validatePassThreshold(0)).not.toThrow();
        expect(() => validatePassThreshold(1)).not.toThrow();
        expect(() => validatePassThreshold(0.8)).not.toThrow();
    });

    it('rejects values outside [0, 1]', () => {
        expect(() => validatePassThreshold(-0.1)).toThrow('--pass-threshold must be between 0 and 1, got "-0.1"');
        expect(() => validatePassThreshold(1.1)).toThrow('--pass-threshold must be between 0 and 1');
    });

    it('rejects NaN, e.g. from a typo like "--pass-threshold high"', () => {
        expect(() => validatePassThreshold(NaN)).toThrow('--pass-threshold must be between 0 and 1, got "NaN"');
    });
});

describe('validateConcurrency()', () => {
    it('accepts a positive integer', () => {
        expect(() => validateConcurrency(1)).not.toThrow();
        expect(() => validateConcurrency(8)).not.toThrow();
    });

    it('rejects zero, negative, non-integer, and NaN values', () => {
        expect(() => validateConcurrency(0)).toThrow('--concurrency must be a positive integer, got "0"');
        expect(() => validateConcurrency(-1)).toThrow('--concurrency must be a positive integer');
        expect(() => validateConcurrency(1.5)).toThrow('--concurrency must be a positive integer');
        expect(() => validateConcurrency(NaN)).toThrow('--concurrency must be a positive integer');
    });
});
