import { describe, expect, it } from 'vitest';

import type { LlmClient } from '../../evals/mcp_agent/llm_client.js';
import { evaluateConversation } from '../../evals/mcp_agent/mcp_agent_judge.js';
import type { ConversationHistory } from '../../evals/mcp_agent/types.js';

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
            return { content: '{"verdict":"PASS","reason":"ok"}' };
        },
    } as unknown as LlmClient;
    return { client, prompt: () => captured };
}

const reference = 'the agent should search';

const conversation: ConversationHistory = {
    userPrompt: 'find an actor',
    turns: [{ toolCalls: [], finalResponse: 'done' }],
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

    it('inserts $-patterns literally instead of letting them rewrite the prompt', async () => {
        // `$'`, `$&`, `` $` `` and `$$` are replacement patterns for String.replace; a Bash
        // command like $'\n' in the transcript must not splice the template around itself.
        const { client, prompt } = makePromptCapturingClient();
        await evaluateConversation(
            'expected $& output $$',
            { ...conversation, userPrompt: "run $'\\n' $` here" },
            client,
        );

        expect(prompt()).toContain("run $'\\n' $` here");
        expect(prompt()).toContain('expected $& output $$');
        expect(prompt()).not.toContain('{{conversation}}');
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
