import { describe, expect, it } from 'vitest';

import { formatBytes, sumResultBytes } from '../../evals/workflows/output_formatter.js';
import type { ConversationHistory } from '../../evals/workflows/types.js';

function makeConversation(turns: ConversationHistory['turns']): ConversationHistory {
    return {
        userPrompt: 'test',
        turns,
        completed: true,
        hitMaxTurns: false,
        totalTurns: turns.length,
    };
}

describe('sumResultBytes()', () => {
    it('returns 0 for a conversation with no tool results', () => {
        const conversation = makeConversation([{ turnNumber: 1, toolCalls: [], toolResults: [], finalResponse: 'hi' }]);
        expect(sumResultBytes(conversation)).toBe(0);
    });

    it('sums resultBytes across all tool results in all turns', () => {
        const conversation = makeConversation([
            {
                turnNumber: 1,
                toolCalls: [],
                toolResults: [
                    { toolName: 'a', success: true, resultBytes: 100 },
                    { toolName: 'b', success: true, resultBytes: 50 },
                ],
            },
            {
                turnNumber: 2,
                toolCalls: [],
                toolResults: [{ toolName: 'c', success: true, resultBytes: 25 }],
            },
        ]);
        expect(sumResultBytes(conversation)).toBe(175);
    });

    it('treats missing resultBytes as 0', () => {
        const conversation = makeConversation([
            {
                turnNumber: 1,
                toolCalls: [],
                toolResults: [
                    { toolName: 'a', success: true },
                    { toolName: 'b', success: true, resultBytes: 30 },
                ],
            },
        ]);
        expect(sumResultBytes(conversation)).toBe(30);
    });
});

describe('formatBytes()', () => {
    it('formats bytes under 1 KB as B', () => {
        expect(formatBytes(0)).toBe('0 B');
        expect(formatBytes(512)).toBe('512 B');
        expect(formatBytes(1023)).toBe('1023 B');
    });

    it('formats kilobytes with one decimal', () => {
        expect(formatBytes(1024)).toBe('1.0 KB');
        expect(formatBytes(1536)).toBe('1.5 KB');
    });

    it('formats megabytes with one decimal', () => {
        expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
        expect(formatBytes(1024 * 1024 * 2.5)).toBe('2.5 MB');
    });
});
