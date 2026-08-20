import { describe, expect, it } from 'vitest';

import type { LlmClient } from '../../evals/workflows/llm_client.js';
import type { ConversationHistory } from '../../evals/workflows/types.js';
import { evaluateConversation, truncateResult } from '../../evals/workflows/workflow_judge.js';

/** A judge response scoring every dimension the same way. */
function rubricResponse(verdict: 'PASS' | 'FAIL' | 'pass', reason = 'the agent searched'): string {
    return JSON.stringify({
        toolSelection: { verdict, reason },
        argumentCorrectness: { verdict, reason },
        resultUtilization: { verdict, reason },
        taskCompletion: { verdict, reason },
        errorRecovery: { verdict, reason },
        planEfficiency: { verdict, reason },
    });
}

/** LLM client that returns one fixed judge response. */
function makeJudgeClient(content: string): LlmClient {
    return {
        callLlm: async () => ({ content }),
    } as unknown as LlmClient;
}

/** LLM client that records the prompt it was asked to judge. */
function makePromptCapturingClient(): { client: LlmClient; prompt: () => string } {
    let captured = '';
    const client = {
        callLlm: async (messages: { content: string }[]) => {
            captured = messages[0].content;
            return { content: rubricResponse('PASS', 'ok') };
        },
    } as unknown as LlmClient;
    return { client, prompt: () => captured };
}

const reference = 'the agent should search';

const conversation: ConversationHistory = {
    userPrompt: 'find an actor',
    turns: [{ toolCalls: [], finalResponse: 'done' }],
};

/** A conversation with one successful MCP tool call. */
const searchConversation: ConversationHistory = {
    userPrompt: 'find an actor',
    turns: [
        {
            toolCalls: [
                {
                    name: 'search-actors',
                    arguments: { search: 'maps' },
                    isMcpTool: true,
                    result: { toolName: 'search-actors', success: true, result: [{ name: 'apify/maps' }] },
                },
            ],
        },
        { toolCalls: [], finalResponse: 'done' },
    ],
};

describe('evaluateConversation()', () => {
    it('normalizes a lowercase verdict instead of erroring the item', async () => {
        const result = await evaluateConversation({
            reference,
            conversation,
            llmClient: makeJudgeClient(rubricResponse('pass')),
        });

        expect(result.overallVerdict).toBe('PASS');
        expect(result.rubric.planEfficiency.verdict).toBe('PASS');
    });

    it('takes the overall verdict from taskCompletion, not from the other dimensions', async () => {
        const response = JSON.parse(rubricResponse('PASS'));
        response.taskCompletion = { verdict: 'FAIL', reason: 'never answered' };
        const result = await evaluateConversation({
            reference,
            conversation,
            llmClient: makeJudgeClient(JSON.stringify(response)),
        });

        expect(result.overallVerdict).toBe('FAIL');
        expect(result.rubric.toolSelection.verdict).toBe('PASS');
    });

    it('inserts $-patterns literally instead of letting them rewrite the prompt', async () => {
        // `$'`, `$&`, `` $` `` and `$$` are replacement patterns for String.replace; a Bash
        // command like $'\n' in the transcript must not splice the template around itself.
        const { client, prompt } = makePromptCapturingClient();
        await evaluateConversation({
            reference: 'expected $& output $$',
            conversation: { ...conversation, userPrompt: "run $'\\n' $` here" },
            llmClient: client,
        });

        expect(prompt()).toContain("run $'\\n' $` here");
        expect(prompt()).toContain('expected $& output $$');
        expect(prompt()).not.toContain('{{conversation}}');
    });

    it('shows the judge what each tool returned', async () => {
        const { client, prompt } = makePromptCapturingClient();
        await evaluateConversation({ reference, conversation: searchConversation, llmClient: client });

        expect(prompt()).toContain('TOOL RESULT (search-actors): [{"name":"apify/maps"}]');
    });

    it('shows the error text of a failed call, which errorRecovery is scored on', async () => {
        const { client, prompt } = makePromptCapturingClient();
        await evaluateConversation({
            reference,
            conversation: {
                userPrompt: 'scrape it',
                turns: [
                    {
                        toolCalls: [
                            {
                                name: 'call-actor',
                                arguments: {},
                                isMcpTool: true,
                                result: { toolName: 'call-actor', success: false, error: 'internal error' },
                            },
                        ],
                    },
                ],
            },
            llmClient: client,
        });

        expect(prompt()).toContain('TOOL ERROR (call-actor): internal error');
    });

    it('rejects a verdict that is neither PASS nor FAIL', async () => {
        await expect(
            evaluateConversation({
                reference,
                conversation,
                llmClient: makeJudgeClient(rubricResponse('maybe' as 'PASS')),
            }),
        ).rejects.toThrow();
    });

    it('rejects a response that is missing a dimension', async () => {
        const response = JSON.parse(rubricResponse('PASS'));
        delete response.errorRecovery;
        await expect(
            evaluateConversation({ reference, conversation, llmClient: makeJudgeClient(JSON.stringify(response)) }),
        ).rejects.toThrow();
    });

    it('keeps the verdicts when the judge returns an unknown extra key', async () => {
        const response = { ...JSON.parse(rubricResponse('PASS')), confidence: 0.9 };
        const result = await evaluateConversation({
            reference,
            conversation,
            llmClient: makeJudgeClient(JSON.stringify(response)),
        });

        expect(result.overallVerdict).toBe('PASS');
    });

    describe('deterministic toolSelection', () => {
        it("overrides the judge's own verdict when expectedTools matches", async () => {
            const result = await evaluateConversation({
                reference,
                expectedTools: ['search-actors'],
                conversation: searchConversation,
                // The judge says the selection was wrong; the check says otherwise and wins.
                llmClient: makeJudgeClient(rubricResponse('FAIL')),
            });

            expect(result.rubric.toolSelection.verdict).toBe('PASS');
            expect(result.rubric.toolSelection.reason).toContain('Deterministic');
            expect(result.toolSelectionCheck.checked).toBe(true);
            // Only this dimension is overridden.
            expect(result.rubric.taskCompletion.verdict).toBe('FAIL');
        });

        it('fails the dimension on a mismatch even when the judge passed it', async () => {
            const result = await evaluateConversation({
                reference,
                expectedTools: ['call-actor'],
                conversation: searchConversation,
                llmClient: makeJudgeClient(rubricResponse('PASS')),
            });

            expect(result.rubric.toolSelection.verdict).toBe('FAIL');
            expect(result.overallVerdict).toBe('PASS');
        });

        it("keeps the judge's verdict when the case sets no expectedTools", async () => {
            const result = await evaluateConversation({
                reference,
                conversation: searchConversation,
                llmClient: makeJudgeClient(rubricResponse('FAIL')),
            });

            expect(result.rubric.toolSelection.verdict).toBe('FAIL');
            expect(result.rubric.toolSelection.reason).toBe('the agent searched');
            expect(result.toolSelectionCheck.checked).toBe(false);
        });
    });
});

describe('truncateResult()', () => {
    it('leaves a short result as serialized JSON', () => {
        expect(truncateResult({ a: 1 })).toBe('{"a":1}');
    });

    it('declares the cut so the judge does not read a truncated result as the whole one', () => {
        expect(truncateResult('x'.repeat(12), 10)).toBe(`${'x'.repeat(10)} [truncated at 10 chars, 12 total]`);
    });

    it('serializes a missing result as null rather than undefined', () => {
        expect(truncateResult(undefined)).toBe('null');
    });
});
