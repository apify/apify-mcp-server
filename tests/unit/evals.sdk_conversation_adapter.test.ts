import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { adaptSdkConversation } from '../../evals/workflows/sdk_conversation_adapter.js';

/** An assistant message as the SDK streams it; only the fields the adapter reads. */
function assistantMessage(content: unknown[], parentToolUseId: string | null = null, id?: string): SDKMessage {
    return {
        type: 'assistant',
        message: { id, content },
        parent_tool_use_id: parentToolUseId,
    } as unknown as SDKMessage;
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

describe('adaptSdkConversation()', () => {
    const toolCallStream: SDKMessage[] = [
        { type: 'system', subtype: 'init', claude_code_version: '2.0.0' } as unknown as SDKMessage,
        assistantMessage([
            { type: 'text', text: 'Let me search.' },
            { type: 'tool_use', id: 'tool-1', name: 'mcp__apify__search-actors', input: { search: 'maps' } },
        ]),
        toolResultMessage([{ type: 'tool_result', tool_use_id: 'tool-1', content: [{ text: 'ok' }] }]),
        resultMessage(),
    ];

    it('hides narration that accompanies tool calls, then appends the final answer', () => {
        const { conversation } = adaptSdkConversation('find a maps scraper', toolCallStream);

        expect(conversation.turns[0]).toMatchObject({
            toolCalls: [{ name: 'search-actors', arguments: { search: 'maps' } }],
        });
        expect(conversation.turns[0].finalResponse).toBeUndefined();
        expect(conversation.turns.at(-1)).toMatchObject({ toolCalls: [], finalResponse: 'Found 3 Actors.' });
    });

    it('keeps a text-only final turn as the single final response, ignoring subagents', () => {
        const { conversation, transcript } = adaptSdkConversation('hi', [
            assistantMessage([{ type: 'text', text: 'subagent narration' }], 'tool-parent'),
            assistantMessage([{ type: 'text', text: 'Found 3 Actors.' }]),
            resultMessage({ num_turns: 1 }),
        ]);

        expect(conversation.turns).toHaveLength(1);
        expect(conversation.turns[0].finalResponse).toBe('Found 3 Actors.');
        expect(transcript).toEqual([{ role: 'assistant', text: 'Found 3 Actors.' }]);
    });

    it('pairs tool results with their call and sizes them', () => {
        const { toolInvocations, metrics } = adaptSdkConversation('find a maps scraper', toolCallStream);

        expect(toolInvocations).toHaveLength(1);
        expect(toolInvocations[0]).toMatchObject({ name: 'search-actors', arguments: { search: 'maps' } });
        expect(toolInvocations[0].result.success).toBe(true);
        expect(metrics.resultBytes).toBe(Buffer.byteLength(JSON.stringify([{ text: 'ok' }]), 'utf8'));
    });

    it('times each invocation from when its call and result were streamed', () => {
        // One per message in toolCallStream: init, assistant, tool result, result.
        const { toolInvocations } = adaptSdkConversation('find a maps scraper', toolCallStream, [10, 20, 50, 60]);

        expect(toolInvocations[0]).toMatchObject({ startedAt: 20, endedAt: 50 });
    });

    it('leaves invocations untimed when the caller did not time the stream', () => {
        const { toolInvocations } = adaptSdkConversation('find a maps scraper', toolCallStream);

        expect(toolInvocations[0].startedAt).toBeUndefined();
        expect(toolInvocations[0].endedAt).toBeUndefined();
    });

    it('marks an errored tool result as failed and keeps the payload as the error', () => {
        const { toolInvocations } = adaptSdkConversation('find a maps scraper', [
            assistantMessage([{ type: 'tool_use', id: 'tool-1', name: 'mcp__apify__search-actors', input: {} }]),
            toolResultMessage([
                { type: 'tool_result', tool_use_id: 'tool-1', content: 'internal error', is_error: true },
            ]),
            resultMessage(),
        ]);

        expect(toolInvocations[0].result).toMatchObject({ success: false, error: 'internal error' });
    });

    it('keeps an errored text block readable instead of JSON-escaping it', () => {
        const { toolInvocations } = adaptSdkConversation('call the browser', [
            assistantMessage([{ type: 'tool_use', id: 'tool-1', name: 'mcp__apify__call-actor', input: {} }]),
            toolResultMessage([
                {
                    type: 'tool_result',
                    tool_use_id: 'tool-1',
                    content: [
                        { type: 'text', text: "Input validation failed.\nErrors: must have required property 'query'" },
                    ],
                    is_error: true,
                },
            ]),
            resultMessage(),
        ]);

        expect(toolInvocations[0].result.error).toBe(
            "Input validation failed.\nErrors: must have required property 'query'",
        );
    });

    it('falls back to pretty JSON for an error payload that is not text', () => {
        const { toolInvocations } = adaptSdkConversation('call the browser', [
            assistantMessage([{ type: 'tool_use', id: 'tool-1', name: 'mcp__apify__call-actor', input: {} }]),
            toolResultMessage([
                { type: 'tool_result', tool_use_id: 'tool-1', content: { code: 'invalid-input' }, is_error: true },
            ]),
            resultMessage(),
        ]);

        expect(toolInvocations[0].result.error).toBe('{\n    "code": "invalid-input"\n}');
    });

    it('counts cached prompt tokens, which the API reports separately', () => {
        const { conversation, metrics } = adaptSdkConversation('hi', [
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
        expect(conversation.totalTokens).toBe(20_320);
    });

    it('appends no final answer when the run ran out of turns', () => {
        const { conversation } = adaptSdkConversation('hi', [
            assistantMessage([{ type: 'tool_use', id: 'tool-1', name: 'mcp__apify__search-actors', input: {} }]),
            resultMessage({ subtype: 'error_max_turns', result: undefined }),
        ]);

        expect(conversation.turns).toHaveLength(1);
        expect(conversation.turns.at(-1)?.finalResponse).toBeUndefined();
    });

    it('stamps when the final model turn opened, so the generation can be windowed to it', () => {
        const { finalTurnStartedAt } = adaptSdkConversation(
            'find a maps scraper',
            [
                assistantMessage(
                    [{ type: 'tool_use', id: 'tool-1', name: 'mcp__apify__search-actors', input: {} }],
                    null,
                    'msg-1',
                ),
                toolResultMessage([{ type: 'tool_result', tool_use_id: 'tool-1', content: [{ text: 'ok' }] }]),
                assistantMessage([{ type: 'thinking', thinking: 'that is the one' }], null, 'msg-2'),
                assistantMessage([{ type: 'text', text: 'Found 3 Actors.' }], null, 'msg-2'),
                resultMessage(),
            ],
            [10, 20, 30, 35, 40],
        );

        // The first frame of the last turn, not the frame the answer text arrived in.
        expect(finalTurnStartedAt).toBe(30);
    });

    it('leaves the final turn unstamped when the caller did not time the stream', () => {
        const { finalTurnStartedAt } = adaptSdkConversation('hi', [
            assistantMessage([{ type: 'text', text: 'done' }]),
            resultMessage({ num_turns: 1 }),
        ]);

        expect(finalTurnStartedAt).toBeUndefined();
    });

    it('throws on a run the SDK aborted, so it is not judged as a failing eval', () => {
        expect(() =>
            adaptSdkConversation('hi', [
                assistantMessage([{ type: 'tool_use', id: 'tool-1', name: 'mcp__apify__search-actors', input: {} }]),
                resultMessage({
                    subtype: 'error_during_execution',
                    result: undefined,
                    errors: ['API error: 529 overloaded'],
                }),
            ]),
        ).toThrow(/error_during_execution.*API error: 529 overloaded/s);
    });

    it('merges the frames the CLI splits one API turn into', () => {
        // The CLI serializes one content block per wire frame, all sharing message.id.
        const { conversation, transcript, toolInvocations } = adaptSdkConversation(
            'find a maps scraper',
            [
                assistantMessage([{ type: 'thinking', thinking: 'which tool?' }], null, 'msg-1'),
                assistantMessage([{ type: 'text', text: 'I found the scraper, calling it now' }], null, 'msg-1'),
                assistantMessage(
                    [{ type: 'tool_use', id: 'tool-1', name: 'mcp__apify__search-actors', input: { search: 'maps' } }],
                    null,
                    'msg-1',
                ),
                toolResultMessage([{ type: 'tool_result', tool_use_id: 'tool-1', content: [{ text: 'ok' }] }]),
                assistantMessage([{ type: 'text', text: 'Found 3 Actors.' }], null, 'msg-2'),
                resultMessage(),
            ],
            [10, 15, 20, 50, 55, 60],
        );

        expect(conversation.turns).toHaveLength(2);
        expect(conversation.turns[0]).toMatchObject({
            turnNumber: 1,
            toolCalls: [{ name: 'search-actors', arguments: { search: 'maps' } }],
        });
        // Narration accompanying a tool call never reaches the judge.
        expect(conversation.turns[0].finalResponse).toBeUndefined();
        expect(conversation.turns[0].toolResults).toHaveLength(1);
        expect(conversation.turns[1]).toMatchObject({ turnNumber: 2, finalResponse: 'Found 3 Actors.' });
        // The tool span still starts when its own frame arrived, not when the turn opened.
        expect(toolInvocations[0]).toMatchObject({ startedAt: 20, endedAt: 50 });
        expect(transcript).toEqual([
            {
                role: 'assistant',
                text: 'I found the scraper, calling it now',
                thinking: 'which tool?',
                toolCalls: ['search-actors'],
            },
            { role: 'assistant', text: 'Found 3 Actors.' },
        ]);
    });

    it('keeps every text block of a merged turn as the final response', () => {
        const { conversation } = adaptSdkConversation('hi', [
            assistantMessage([{ type: 'text', text: 'Part A' }], null, 'msg-1'),
            assistantMessage([{ type: 'text', text: 'Part B' }], null, 'msg-1'),
            resultMessage({ result: 'Part A\nPart B', num_turns: 1 }),
        ]);

        expect(conversation.turns).toHaveLength(1);
        expect(conversation.turns[0].finalResponse).toBe('Part A\nPart B');
    });

    it('records narration, thinking, and tool names in the transcript', () => {
        const { transcript } = adaptSdkConversation('hi', [
            assistantMessage([
                { type: 'thinking', thinking: 'which tool?' },
                { type: 'text', text: 'Let me search.' },
                { type: 'tool_use', id: 'tool-1', name: 'mcp__apify__search-actors', input: {} },
            ]),
            resultMessage({ num_turns: 1 }),
        ]);

        expect(transcript[0]).toEqual({
            role: 'assistant',
            text: 'Let me search.',
            thinking: 'which tool?',
            toolCalls: ['search-actors'],
        });
    });
});
