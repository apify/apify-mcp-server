import { describe, expect, it } from 'vitest';

import { checkToolSelection } from '../../evals/workflows/deterministic_checks.js';
import type { ConversationHistory, ConversationToolCall } from '../../evals/workflows/types.js';

function mcpCall(name: string): ConversationToolCall {
    return { name, arguments: {}, isMcpTool: true };
}

function builtInCall(name: string): ConversationToolCall {
    return { name, arguments: {}, isMcpTool: false };
}

function makeConversation(...toolCalls: ConversationToolCall[]): ConversationHistory {
    // One call per turn, so the check is exercised across turns rather than within one.
    return { userPrompt: 'q', turns: toolCalls.map((call) => ({ toolCalls: [call] })) };
}

describe('checkToolSelection()', () => {
    it('passes when the called tools match, ignoring order', () => {
        const check = checkToolSelection(
            ['get-dataset-items', 'call-actor'],
            makeConversation(mcpCall('call-actor'), mcpCall('get-dataset-items')),
        );

        expect(check).toEqual({
            checked: true,
            verdict: 'PASS',
            expected: ['call-actor', 'get-dataset-items'],
            actual: ['call-actor', 'get-dataset-items'],
        });
    });

    it('passes when a tool was called more than once', () => {
        const check = checkToolSelection(
            ['call-actor'],
            makeConversation(mcpCall('call-actor'), mcpCall('call-actor')),
        );

        expect(check.verdict).toBe('PASS');
        expect(check.actual).toEqual(['call-actor']);
    });

    it('fails on a missing tool', () => {
        const check = checkToolSelection(['call-actor', 'get-dataset-items'], makeConversation(mcpCall('call-actor')));

        expect(check.verdict).toBe('FAIL');
    });

    it('fails on an extra tool', () => {
        const check = checkToolSelection(
            ['call-actor'],
            makeConversation(mcpCall('call-actor'), mcpCall('search-actors')),
        );

        expect(check.verdict).toBe('FAIL');
        expect(check.actual).toEqual(['call-actor', 'search-actors']);
    });

    it("ignores Claude Code's built-in tools, which say nothing about selecting ours", () => {
        const check = checkToolSelection(
            ['search-actors'],
            makeConversation(builtInCall('TodoWrite'), mcpCall('search-actors'), builtInCall('Read')),
        );

        expect(check.verdict).toBe('PASS');
        expect(check.actual).toEqual(['search-actors']);
    });

    it('reports nothing checked when the case sets no expectedTools', () => {
        const check = checkToolSelection(undefined, makeConversation(mcpCall('search-actors')));

        expect(check).toEqual({ checked: false, verdict: null, expected: [], actual: ['search-actors'] });
    });

    it('treats an empty expectedTools as unset rather than as "no tools at all"', () => {
        // An empty array in the dataset is far more likely a half-finished edit than a case
        // asserting the agent must call nothing.
        expect(checkToolSelection([], makeConversation(mcpCall('search-actors'))).checked).toBe(false);
    });
});
