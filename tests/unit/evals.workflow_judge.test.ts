import { describe, expect, it } from 'vitest';

import type { LlmClient } from '../../evals/workflows/llm_client.js';
import type { ConversationHistory } from '../../evals/workflows/types.js';
import { evaluateConversation } from '../../evals/workflows/workflow_judge.js';

/** LLM client that returns one fixed judge response. */
function makeJudgeClient(content: string): LlmClient {
    return {
        callLlm: async () => ({ content }),
    } as unknown as LlmClient;
}

const reference = 'the agent should search';

const conversation: ConversationHistory = {
    userPrompt: 'find an actor',
    turns: [{ turnNumber: 1, toolCalls: [], toolResults: [], finalResponse: 'done' }],
    completed: true,
    hitMaxTurns: false,
    totalTurns: 1,
};

describe('evaluateConversation()', () => {
    it('normalizes a lowercase verdict instead of erroring the item', async () => {
        const result = await evaluateConversation(
            reference,
            conversation,
            makeJudgeClient('{"verdict":"pass","reason":"the agent searched"}'),
        );

        expect(result.verdict).toBe('PASS');
    });

    it('rejects a verdict that is neither PASS nor FAIL', async () => {
        await expect(
            evaluateConversation(reference, conversation, makeJudgeClient('{"verdict":"maybe","reason":"unclear"}')),
        ).rejects.toThrow();
    });

    it('keeps the verdict when the judge returns an unknown extra key', async () => {
        const result = await evaluateConversation(
            reference,
            conversation,
            makeJudgeClient('{"verdict":"PASS","reason":"the agent searched","confidence":0.9}'),
        );

        expect(result.verdict).toBe('PASS');
    });
});
