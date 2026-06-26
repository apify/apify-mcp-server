import { describe, expect, it } from 'vitest';

import type { EvaluationResult, TestResultRecord } from '../../evals/workflows/output_formatter.js';
import {
    formatBytes,
    formatResultsTable,
    formatTokens,
    formatWithDelta,
    sumResultBytes,
} from '../../evals/workflows/output_formatter.js';
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

describe('formatTokens()', () => {
    it('formats token counts with thousands separators', () => {
        expect(formatTokens(0)).toBe('0');
        expect(formatTokens(412)).toBe('412');
        expect(formatTokens(6643)).toBe('6,643');
        expect(formatTokens(1234567)).toBe('1,234,567');
    });
});

describe('formatWithDelta()', () => {
    it('shows no baseline when baseline is undefined', () => {
        expect(formatWithDelta(1024, undefined, formatBytes)).toBe('1.0 KB (no baseline)');
    });

    it('marks an unchanged value', () => {
        expect(formatWithDelta(2048, 2048, formatBytes)).toBe('2.0 KB (= baseline)');
    });

    it('marks a reduction with ▼ and a negative percentage', () => {
        expect(formatWithDelta(900, 1000, formatTokens)).toBe('900 (▼ -100 / -10.0%)');
    });

    it('marks an increase with ▲ and a positive percentage', () => {
        expect(formatWithDelta(1100, 1000, formatTokens)).toBe('1,100 (▲ +100 / +10.0%)');
    });

    it('reports n/a percentage when baseline is zero', () => {
        expect(formatWithDelta(50, 0, formatTokens)).toBe('50 (▲ +50 / n/a)');
    });
});

describe('formatResultsTable()', () => {
    function makeResult(testId: string, bytes: number, tokens: number): EvaluationResult {
        return {
            testCase: { id: testId, category: 'basic', query: 'q', reference: 'r' } as EvaluationResult['testCase'],
            conversation: {
                ...makeConversation([
                    {
                        turnNumber: 1,
                        toolCalls: [],
                        toolResults: [{ toolName: 't', success: true, resultBytes: bytes }],
                    },
                ]),
                totalTokens: tokens,
            },
            judgeResult: { verdict: 'PASS', reason: 'ok', rawResponse: '' },
            durationMs: 100,
        };
    }

    function makeRecord(testId: string, resultBytes: number, totalTokens: number): TestResultRecord {
        return {
            timestamp: '2026-01-01T00:00:00.000Z',
            agentModel: 'm',
            judgeModel: 'j',
            testId,
            verdict: 'PASS',
            reason: 'ok',
            durationMs: 100,
            turns: 1,
            resultBytes,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens,
            error: null,
        };
    }

    it('omits the baseline section when no baseline is given', () => {
        const table = formatResultsTable([makeResult('a', 1000, 500)]);
        expect(table).not.toContain('vs baseline');
        expect(table).toContain('Tool bytes:');
    });

    it('shows per-test and aggregate deltas against a baseline', () => {
        const baseline = new Map<string, TestResultRecord>([['a', makeRecord('a', 2000, 800)]]);
        const table = formatResultsTable([makeResult('a', 1000, 500)], baseline);
        // Per-test: bytes halved, tokens down
        expect(table).toContain('▼');
        expect(table).toContain('-50.0%'); // 1000 vs 2000 bytes
        // Aggregate section present
        expect(table).toContain('vs baseline:');
        expect(table).toContain('Tool bytes (1/1):');
        expect(table).toContain('Tokens (1/1):');
    });

    it('shows no-baseline for a test missing from the baseline map', () => {
        const baseline = new Map<string, TestResultRecord>([['a', makeRecord('a', 2000, 800)]]);
        const table = formatResultsTable([makeResult('b', 1000, 500)], baseline);
        expect(table).toContain('(no baseline)');
    });
});
