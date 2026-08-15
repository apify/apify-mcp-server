import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { buildAgentRun } from '../../evals/workflows/sdk_run.js';

/** An assistant message as the SDK streams it; only the fields the adapter reads. */
function assistantMessage(content: unknown[], parentToolUseId: string | null = null): SDKMessage {
    return { type: 'assistant', message: { content }, parent_tool_use_id: parentToolUseId } as unknown as SDKMessage;
}

/** A user message carrying tool results. */
function toolResultMessage(content: unknown[], parentToolUseId: string | null = null): SDKMessage {
    return { type: 'user', message: { content }, parent_tool_use_id: parentToolUseId } as unknown as SDKMessage;
}

function resultMessage(overrides: Record<string, unknown> = {}): SDKMessage {
    return {
        type: 'result',
        subtype: 'success',
        result: 'Found 3 Actors.',
        num_turns: 2,
        total_cost_usd: 0.01,
        duration_ms: 1500,
        usage: { input_tokens: 100, output_tokens: 20 },
        ...overrides,
    } as unknown as SDKMessage;
}

describe('buildAgentRun()', () => {
    const toolCallStream: SDKMessage[] = [
        { type: 'system', subtype: 'init', claude_code_version: '2.0.0' } as unknown as SDKMessage,
        assistantMessage([
            { type: 'text', text: 'Let me search.' },
            { type: 'tool_use', id: 'tool-1', name: 'mcp__apify__search-actors', input: { search: 'maps' } },
        ]),
        toolResultMessage([{ type: 'tool_result', tool_use_id: 'tool-1', content: [{ text: 'ok' }] }]),
        resultMessage(),
    ];

    it('pairs tool results with their call and sizes them', () => {
        const { toolInvocations, metrics } = buildAgentRun(toolCallStream);

        expect(toolInvocations).toHaveLength(1);
        expect(toolInvocations[0]).toMatchObject({ name: 'search-actors', arguments: { search: 'maps' } });
        expect(toolInvocations[0].result.success).toBe(true);
        expect(metrics.resultBytes).toBe(Buffer.byteLength(JSON.stringify([{ text: 'ok' }]), 'utf8'));
    });

    it('marks an errored tool result as failed and keeps the payload as the error', () => {
        const { toolInvocations } = buildAgentRun([
            assistantMessage([{ type: 'tool_use', id: 'tool-1', name: 'mcp__apify__search-actors', input: {} }]),
            toolResultMessage([
                { type: 'tool_result', tool_use_id: 'tool-1', content: 'internal error', is_error: true },
            ]),
            resultMessage(),
        ]);

        expect(toolInvocations[0].result).toMatchObject({ success: false, error: '"internal error"' });
    });

    it('counts cached prompt tokens, which the API reports separately', () => {
        const { totalTokens, metrics } = buildAgentRun([
            assistantMessage([{ type: 'text', text: 'done' }]),
            resultMessage({
                usage: {
                    input_tokens: 15,
                    output_tokens: 5,
                    cache_read_input_tokens: 20_000,
                    cache_creation_input_tokens: 300,
                },
            }),
        ]);

        expect(metrics.promptTokens).toBe(20_315);
        expect(totalTokens).toBe(20_320);
    });

    it('flags a run that ran out of turns as incomplete', () => {
        const { completed, hitMaxTurns } = buildAgentRun([
            assistantMessage([{ type: 'tool_use', id: 'tool-1', name: 'mcp__apify__search-actors', input: {} }]),
            resultMessage({ subtype: 'error_max_turns', result: undefined }),
        ]);

        expect(completed).toBe(false);
        expect(hitMaxTurns).toBe(true);
    });

    it('throws on a run the SDK aborted, so it is not judged as a failing eval', () => {
        expect(() =>
            buildAgentRun([
                assistantMessage([{ type: 'tool_use', id: 'tool-1', name: 'mcp__apify__search-actors', input: {} }]),
                resultMessage({
                    subtype: 'error_during_execution',
                    result: undefined,
                    errors: ['API error: 529 overloaded'],
                }),
            ]),
        ).toThrow(/error_during_execution.*API error: 529 overloaded/s);
    });

    it('records narration, thinking, and tool names in the transcript, ignoring subagents', () => {
        const { transcript } = buildAgentRun([
            assistantMessage([{ type: 'text', text: 'subagent narration' }], 'tool-parent'),
            assistantMessage([
                { type: 'thinking', thinking: 'which tool?' },
                { type: 'text', text: 'Let me search.' },
                { type: 'tool_use', id: 'tool-1', name: 'mcp__apify__search-actors', input: {} },
            ]),
            resultMessage({ num_turns: 1 }),
        ]);

        expect(transcript).toHaveLength(1);
        expect(transcript[0]).toEqual({
            role: 'assistant',
            text: 'Let me search.',
            thinking: 'which tool?',
            toolCalls: ['search-actors'],
        });
    });
});
