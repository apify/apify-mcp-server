import { describe, expect, it, vi } from 'vitest';

import type { WorkflowTestCase } from '../../evals/shared/types.js';
import type { LlmClient } from '../../evals/workflows/llm_client.js';
import type { ConversationHistory, McpTool } from '../../evals/workflows/types.js';
import { evaluateConversation, truncateResult } from '../../evals/workflows/workflow_judge.js';

/** Judge response with every dimension passing, so a FAIL can only come from a deterministic check. */
const ALL_PASS_RESPONSE = JSON.stringify({
    toolSelection: { verdict: 'PASS', reason: 'judge says tools were fine' },
    argumentCorrectness: { verdict: 'PASS', reason: 'args ok' },
    resultUtilization: { verdict: 'PASS', reason: 'results used' },
    taskCompletion: { verdict: 'PASS', reason: 'task done' },
    errorRecovery: { verdict: 'PASS', reason: 'nothing to recover from' },
    planEfficiency: { verdict: 'PASS', reason: 'direct path' },
});

function makeLlmClient(content: string): { client: LlmClient; callLlm: ReturnType<typeof vi.fn> } {
    const callLlm = vi.fn().mockResolvedValue({ content });
    return { client: { callLlm } as unknown as LlmClient, callLlm };
}

function makeConversation(): ConversationHistory {
    return {
        userPrompt: 'run the actor',
        turns: [
            {
                turnNumber: 1,
                toolCalls: [{ name: 'call-actor', arguments: { actor: 'apify/rag-web-browser' } }],
                toolResults: [{ toolName: 'call-actor', success: false, error: 'internal error' }],
            },
            { turnNumber: 2, toolCalls: [], toolResults: [], finalResponse: 'It failed.' },
        ],
        completed: true,
        hitMaxTurns: false,
        totalTurns: 2,
    };
}

const TEST_CASE: WorkflowTestCase = { id: 't', category: 'call', query: 'q', reference: 'requirements' };

describe('truncateResult()', () => {
    it('returns short results unchanged', () => {
        expect(truncateResult({ a: 1 })).toBe('{"a":1}');
    });

    it('keeps a result exactly at the cap unchanged', () => {
        expect(truncateResult('x'.repeat(10), 10)).toBe('x'.repeat(10));
    });

    it('slices past the cap and notes the original length', () => {
        expect(truncateResult('x'.repeat(12), 10)).toBe(`${'x'.repeat(10)}  [truncated at 10 chars, 12 total]`);
    });

    it('passes strings through without re-quoting them', () => {
        expect(truncateResult('plain error text')).toBe('plain error text');
    });
});

describe('evaluateConversation()', () => {
    it('sets overallVerdict from the taskCompletion dimension', async () => {
        const response = JSON.parse(ALL_PASS_RESPONSE);
        response.taskCompletion = { verdict: 'FAIL', reason: 'never answered' };
        const { client } = makeLlmClient(JSON.stringify(response));

        const result = await evaluateConversation(TEST_CASE, makeConversation(), client);
        expect(result.overallVerdict).toBe('FAIL');
        expect(result.rubric.planEfficiency.verdict).toBe('PASS');
    });

    it('overrides the judge toolSelection verdict when expectedTools is set', async () => {
        const { client } = makeLlmClient(ALL_PASS_RESPONSE);
        const testCase: WorkflowTestCase = { ...TEST_CASE, expectedTools: ['call-actor', 'get-dataset-items'] };

        const result = await evaluateConversation(testCase, makeConversation(), client);
        expect(result.toolSelectionCheck.checked).toBe(true);
        // Judge said PASS; the deterministic mismatch wins.
        expect(result.rubric.toolSelection.verdict).toBe('FAIL');
        expect(result.rubric.toolSelection.reason).toBe(
            'Deterministic: expected [call-actor, get-dataset-items], got [call-actor]',
        );
    });

    it('keeps the judge toolSelection verdict when expectedTools is unset', async () => {
        const { client } = makeLlmClient(ALL_PASS_RESPONSE);

        const result = await evaluateConversation(TEST_CASE, makeConversation(), client);
        expect(result.toolSelectionCheck.checked).toBe(false);
        expect(result.rubric.toolSelection.reason).toBe('judge says tools were fine');
    });

    it('does not flag a forced tool failure as a schema violation', async () => {
        const { client } = makeLlmClient(ALL_PASS_RESPONSE);
        const tools: McpTool[] = [
            {
                name: 'call-actor',
                inputSchema: { type: 'object', properties: { actor: { type: 'string' } }, required: ['actor'] },
            },
        ];

        const result = await evaluateConversation(TEST_CASE, makeConversation(), client, undefined, tools);
        expect(result.schemaValidityCheck).toEqual({ verdict: 'PASS', invalidCalls: [] });
    });

    it('shows tool results and errors to the judge', async () => {
        const { client, callLlm } = makeLlmClient(ALL_PASS_RESPONSE);

        await evaluateConversation(TEST_CASE, makeConversation(), client);
        const prompt = callLlm.mock.calls[0][0][0].content as string;
        expect(prompt).toContain('AGENT: [Called tool: call-actor with args: {"actor":"apify/rag-web-browser"}]');
        expect(prompt).toContain('TOOL ERROR (call-actor): internal error');
    });

    it('rejects a judge response missing a dimension', async () => {
        const partial = JSON.parse(ALL_PASS_RESPONSE);
        delete partial.errorRecovery;
        const { client } = makeLlmClient(JSON.stringify(partial));

        await expect(evaluateConversation(TEST_CASE, makeConversation(), client)).rejects.toThrow(
            /Invalid verdict for dimension errorRecovery/,
        );
    });
});
