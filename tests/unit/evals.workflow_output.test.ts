import { describe, expect, it } from 'vitest';

import type { EvaluationResult, TestResultRecord } from '../../evals/workflows/output_formatter.js';
import {
    aggregateRepeatedResults,
    formatBytes,
    formatRepeatSummaryTable,
    formatResultsTable,
    formatTokens,
    formatWithDelta,
    getCallActorTargets,
    getToolCallTrace,
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

describe('getToolCallTrace()', () => {
    it("carries each tool call's startedAt and durationMs through to the trace entry", () => {
        const conversation = makeConversation([
            {
                turnNumber: 1,
                toolCalls: [{ name: 'call-actor', arguments: { actor: 'apify/code-runtime' } }],
                toolResults: [
                    {
                        toolName: 'call-actor',
                        success: true,
                        result: {},
                        startedAt: '2026-01-01T00:00:00.000Z',
                        durationMs: 4321,
                    },
                ],
            },
        ]);

        const [entry] = getToolCallTrace(conversation);
        expect(entry.startedAt).toBe('2026-01-01T00:00:00.000Z');
        expect(entry.durationMs).toBe(4321);
    });

    it('leaves startedAt/durationMs undefined when the tool result never recorded them', () => {
        const conversation = makeConversation([
            {
                turnNumber: 1,
                toolCalls: [{ name: 'search-actors', arguments: {} }],
                toolResults: [{ toolName: 'search-actors', success: true, result: {} }],
            },
        ]);

        const [entry] = getToolCallTrace(conversation);
        expect(entry.startedAt).toBeUndefined();
        expect(entry.durationMs).toBeUndefined();
    });
});

describe('getCallActorTargets()', () => {
    it('returns distinct Actor IDs targeted through call-actor', () => {
        const conversation = makeConversation([
            {
                turnNumber: 1,
                toolCalls: [
                    { name: 'call-actor', arguments: { actor: 'apify/code-runtime' } },
                    { name: 'call-actor', arguments: { actor: 'apify/instagram-scraper' } },
                    { name: 'call-actor', arguments: { actor: 'apify/code-runtime' } },
                    { name: 'search-actors', arguments: { keywords: 'maps' } },
                ],
                toolResults: [],
            },
        ]);

        expect(getCallActorTargets(conversation)).toEqual(['apify/code-runtime', 'apify/instagram-scraper']);
    });

    it('strips an MCP tool-name suffix from the Actor target', () => {
        const conversation = makeConversation([
            {
                turnNumber: 1,
                toolCalls: [{ name: 'call-actor', arguments: { actor: 'apify/actors-mcp-server:fetch-apify-docs' } }],
                toolResults: [],
            },
        ]);

        expect(getCallActorTargets(conversation)).toEqual(['apify/actors-mcp-server']);
    });

    it('returns an empty array when call-actor was never invoked', () => {
        const conversation = makeConversation([
            { turnNumber: 1, toolCalls: [{ name: 'search-actors', arguments: {} }], toolResults: [] },
        ]);

        expect(getCallActorTargets(conversation)).toEqual([]);
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
            toolCalls: 0,
            failedToolCalls: 0,
            policyViolations: [],
            finalResponse: '',
            toolCallTrace: [],
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

describe('aggregateRepeatedResults()', () => {
    function makeAttempt(
        testId: string,
        overrides: Partial<EvaluationResult> & { durationMs?: number; tokens?: number; bytes?: number } = {},
    ): EvaluationResult {
        const { durationMs = 100, tokens = 500, bytes = 1000, ...rest } = overrides;
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
            durationMs,
            ...rest,
        };
    }

    it('counts pass/fail/timeout/error into separate buckets', () => {
        const results = [
            makeAttempt('a', { judgeResult: { verdict: 'PASS', reason: 'ok', rawResponse: '' } }),
            makeAttempt('a', { judgeResult: { verdict: 'PASS', reason: 'ok', rawResponse: '' } }),
            makeAttempt('a', { judgeResult: { verdict: 'FAIL', reason: 'wrong', rawResponse: '' } }),
            makeAttempt('a', { error: 'Test exceeded 300s timeout', timedOut: true }),
            makeAttempt('a', { error: 'MCP error -32000: Connection closed' }),
        ];

        const [summary] = aggregateRepeatedResults(results);
        expect(summary.attempts).toBe(5);
        expect(summary.passed).toBe(2);
        expect(summary.failed).toBe(1);
        expect(summary.timedOut).toBe(1);
        expect(summary.errored).toBe(1);
        expect(summary.passRate).toBe(0.4);
        expect(summary.completionRate).toBe(0.6); // passed + failed, not errored/timed-out
    });

    it('computes duration/token/byte stats only over completed attempts, excluding errored ones', () => {
        const results = [
            makeAttempt('a', { durationMs: 100, tokens: 200, bytes: 1000 }),
            makeAttempt('a', { durationMs: 300, tokens: 600, bytes: 3000 }),
            // A timed-out attempt capped at 900s shouldn't drag the "typical duration" toward 900s.
            makeAttempt('a', { durationMs: 900_000, error: 'Test exceeded 900s timeout', timedOut: true }),
        ];

        const [summary] = aggregateRepeatedResults(results);
        expect(summary.medianDurationMs).toBe(200);
        expect(summary.meanDurationMs).toBe(200);
        expect(summary.medianTokens).toBe(400);
        expect(summary.medianToolBytes).toBe(2000);
    });

    it('leaves duration/token/byte stats undefined when every attempt errored', () => {
        const results = [makeAttempt('a', { error: 'boom' }), makeAttempt('a', { error: 'boom again' })];

        const [summary] = aggregateRepeatedResults(results);
        expect(summary.medianDurationMs).toBeUndefined();
        expect(summary.meanTokens).toBeUndefined();
    });

    it('groups by test case id, keeping each test case a separate summary', () => {
        const results = [makeAttempt('a'), makeAttempt('a'), makeAttempt('b')];

        const summaries = aggregateRepeatedResults(results);
        expect(summaries).toHaveLength(2);
        expect(summaries.find((s) => s.testId === 'a')?.attempts).toBe(2);
        expect(summaries.find((s) => s.testId === 'b')?.attempts).toBe(1);
    });
});

describe('formatRepeatSummaryTable()', () => {
    it('renders pass/completion rates and per-attempt-type counts', () => {
        const results = [
            {
                testId: 'a',
                category: 'basic',
                attempts: 4,
                passed: 2,
                failed: 1,
                timedOut: 1,
                errored: 0,
                passRate: 0.5,
                completionRate: 0.75,
                medianDurationMs: 1000,
                meanDurationMs: 1100,
                medianTokens: 500,
                meanTokens: 550,
                medianToolBytes: 2000,
                meanToolBytes: 2100,
            },
        ];

        const table = formatRepeatSummaryTable(results);
        expect(table).toContain('a (basic)');
        expect(table).toContain('Pass rate: 2/4 (50%)');
        expect(table).toContain('Completion rate: 3/4 (75%)');
        expect(table).toContain('Wrong answer: 1 | Timed out: 1 | Other errors: 0');
        expect(table).toContain('median 1000ms');
    });

    it('flags a test case with no completed attempts instead of printing undefined', () => {
        const results = [
            {
                testId: 'a',
                category: 'basic',
                attempts: 2,
                passed: 0,
                failed: 0,
                timedOut: 2,
                errored: 0,
                passRate: 0,
                completionRate: 0,
            },
        ];

        const table = formatRepeatSummaryTable(results);
        expect(table).toContain('No completed attempts to measure duration/tokens/bytes from.');
    });
});
