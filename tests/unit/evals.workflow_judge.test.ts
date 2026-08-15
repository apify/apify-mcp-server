import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import type { LlmClient } from '../../evals/workflows/llm_client.js';
import { evaluateConversation, formatSdkStreamForJudge } from '../../evals/workflows/workflow_judge.js';

function assistant(content: unknown[], parentToolUseId: string | null = null): SDKMessage {
    return { type: 'assistant', message: { content }, parent_tool_use_id: parentToolUseId } as unknown as SDKMessage;
}

function success(result?: string): SDKMessage {
    return {
        type: 'result',
        subtype: 'success',
        result,
        usage: { input_tokens: 1, output_tokens: 1 },
    } as unknown as SDKMessage;
}

const toolUse = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input });

/** LLM client that returns one fixed judge response. */
function makeJudgeClient(content: string): LlmClient {
    return {
        callLlm: async () => ({ content }),
    } as unknown as LlmClient;
}

const reference = 'the agent should search';

const userPrompt = 'find an actor';

const messages: SDKMessage[] = [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] }, parent_tool_use_id: null },
    { type: 'result', subtype: 'success', result: 'done', usage: { input_tokens: 1, output_tokens: 1 } },
] as unknown as SDKMessage[];

describe('formatSdkStreamForJudge()', () => {
    it('strips the MCP prefix and hides narration that accompanies a tool call', () => {
        const formatted = formatSdkStreamForJudge('find a maps scraper', [
            assistant([
                { type: 'text', text: 'Let me search.' },
                toolUse('t1', 'mcp__apify__search-actors', { search: 'maps' }),
            ]),
            success('Found 3 Actors.'),
        ]);

        expect(formatted).toBe(
            'USER: find a maps scraper\n\n' +
                'AGENT: [Called tool: search-actors with args: {"search":"maps"}]\n\n' +
                'AGENT: Found 3 Actors.',
        );
    });

    it('keeps a text-only final message as the single answer, without repeating the result', () => {
        const formatted = formatSdkStreamForJudge('hi', [
            assistant([{ type: 'text', text: 'Found 3.' }]),
            success('Found 3.'),
        ]);

        expect(formatted).toBe('USER: hi\n\nAGENT: Found 3.');
    });

    it('ignores subagent messages', () => {
        const formatted = formatSdkStreamForJudge('hi', [
            assistant([{ type: 'text', text: 'subagent narration' }], 'tool-parent'),
            assistant([{ type: 'text', text: 'Found 3.' }]),
            success('Found 3.'),
        ]);

        expect(formatted).toBe('USER: hi\n\nAGENT: Found 3.');
    });

    it('leaves the answer out when the run produced no success result', () => {
        const formatted = formatSdkStreamForJudge('hi', [
            assistant([toolUse('t1', 'mcp__apify__search-actors', {})]),
            { type: 'result', subtype: 'error_max_turns' } as unknown as SDKMessage,
        ]);

        expect(formatted).toBe('USER: hi\n\nAGENT: [Called tool: search-actors with args: {}]');
    });

    it('appends the result when no assistant message carried the answer alone', () => {
        const formatted = formatSdkStreamForJudge('hi', [success('Found 3.')]);

        expect(formatted).toBe('USER: hi\n\nAGENT: Found 3.');
    });
});

describe('evaluateConversation()', () => {
    it('normalizes a lowercase verdict instead of erroring the item', async () => {
        const result = await evaluateConversation(
            reference,
            userPrompt,
            messages,
            makeJudgeClient('{"verdict":"pass","reason":"the agent searched"}'),
        );

        expect(result.verdict).toBe('PASS');
    });

    it('rejects a verdict that is neither PASS nor FAIL', async () => {
        await expect(
            evaluateConversation(
                reference,
                userPrompt,
                messages,
                makeJudgeClient('{"verdict":"maybe","reason":"unclear"}'),
            ),
        ).rejects.toThrow();
    });

    it('keeps the verdict when the judge returns an unknown extra key', async () => {
        const result = await evaluateConversation(
            reference,
            userPrompt,
            messages,
            makeJudgeClient('{"verdict":"PASS","reason":"the agent searched","confidence":0.9}'),
        );

        expect(result.verdict).toBe('PASS');
    });
});
