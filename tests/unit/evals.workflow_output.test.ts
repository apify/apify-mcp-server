import { describe, expect, it } from 'vitest';

import type { EvaluationResult, TestResultRecord } from '../../evals/workflows/output_formatter.js';
import {
    formatBytes,
    formatDetailedResult,
    formatPassRateWithDelta,
    formatResultsTable,
    formatRubricGlyphs,
    formatTokens,
    formatWithDelta,
    sumResultBytes,
} from '../../evals/workflows/output_formatter.js';
import type { ConversationHistory } from '../../evals/workflows/types.js';
import type { JudgeResult, RubricResult } from '../../evals/workflows/workflow_judge.js';

function makeRubric(overrides: Partial<RubricResult> = {}): RubricResult {
    const pass = { verdict: 'PASS' as const, reason: 'ok' };
    return {
        toolSelection: pass,
        argumentCorrectness: pass,
        resultUtilization: pass,
        taskCompletion: pass,
        errorRecovery: pass,
        planEfficiency: pass,
        ...overrides,
    };
}

function makeJudgeResult(overrides: Partial<JudgeResult> = {}): JudgeResult {
    const rubric = overrides.rubric ?? makeRubric();
    return {
        overallVerdict: rubric.taskCompletion.verdict,
        rubric,
        toolSelectionCheck: { checked: false, verdict: null, expected: [], actual: [] },
        schemaValidityCheck: { verdict: 'PASS', invalidCalls: [] },
        rawResponse: '',
        ...overrides,
    };
}

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
            judgeResult: makeJudgeResult(),
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

    it('renders the compact rubric glyph line and per-dimension pass rates', () => {
        const result = makeResult('a', 1000, 500);
        result.judgeResult = makeJudgeResult({
            rubric: makeRubric({ resultUtilization: { verdict: 'FAIL', reason: 'ignored an error' } }),
        });
        const table = formatResultsTable([result]);
        expect(table).toContain('Rubric: tool✓ args✓ result✗ complete✓ recover✓ eff✓');
        expect(table).toContain('Result utilization: 0/1 passed');
        expect(table).toContain('Task completion: 1/1 passed');
    });

    it('derives the per-test status from overallVerdict, not from the other dimensions', () => {
        const result = makeResult('a', 1000, 500);
        result.judgeResult = makeJudgeResult({
            rubric: makeRubric({ taskCompletion: { verdict: 'FAIL', reason: 'no answer' } }),
        });
        const table = formatResultsTable([result]);
        expect(table).toContain('❌ FAIL | a');
        expect(table).toContain('Reason: no answer');
    });

    it('lists schema-invalid calls only when the schema check fails', () => {
        const passing = formatResultsTable([makeResult('a', 1000, 500)]);
        expect(passing).not.toContain('Schema-invalid calls');

        const result = makeResult('a', 1000, 500);
        result.judgeResult = makeJudgeResult({
            schemaValidityCheck: {
                verdict: 'FAIL',
                invalidCalls: [{ toolName: 'get-dataset-items', errors: ['/limit must be integer'] }],
            },
        });
        expect(formatResultsTable([result])).toContain(
            'Schema-invalid calls: get-dataset-items (/limit must be integer)',
        );
    });

    it('shows per-dimension baseline deltas only for baselines that carry a rubric', () => {
        const withoutRubric = new Map<string, TestResultRecord>([['a', makeRecord('a', 2000, 800)]]);
        expect(formatResultsTable([makeResult('a', 1000, 500)], withoutRubric)).not.toContain('Task completion (');

        const record = makeRecord('a', 2000, 800);
        record.rubric = makeRubric();
        const withRubric = new Map<string, TestResultRecord>([['a', record]]);
        const result = makeResult('a', 1000, 500);
        result.judgeResult = makeJudgeResult({
            rubric: makeRubric({ planEfficiency: { verdict: 'FAIL', reason: 'looped' } }),
        });
        const table = formatResultsTable([result], withRubric);
        expect(table).toContain('Task completion (1/1): 1/1 passed (= baseline)');
        expect(table).toContain('Plan efficiency (1/1): 0/1 passed (▼ -1 vs baseline 1/1)');
    });
});

describe('formatRubricGlyphs()', () => {
    it('renders one glyph per dimension in a fixed order', () => {
        expect(formatRubricGlyphs(makeRubric())).toBe('tool✓ args✓ result✓ complete✓ recover✓ eff✓');
        expect(formatRubricGlyphs(makeRubric({ errorRecovery: { verdict: 'FAIL', reason: 'stalled' } }))).toBe(
            'tool✓ args✓ result✓ complete✓ recover✗ eff✓',
        );
    });
});

describe('formatPassRateWithDelta()', () => {
    it('marks an unchanged pass count', () => {
        expect(formatPassRateWithDelta(27, 27, 30)).toBe('27/30 passed (= baseline)');
    });

    it('marks more passes with ▲ (better)', () => {
        expect(formatPassRateWithDelta(29, 27, 30)).toBe('29/30 passed (▲ +2 vs baseline 27/30)');
    });

    it('marks fewer passes with ▼ (worse)', () => {
        expect(formatPassRateWithDelta(27, 29, 30)).toBe('27/30 passed (▼ -2 vs baseline 29/30)');
    });
});

describe('formatDetailedResult()', () => {
    function makeVerboseResult(judgeResult: JudgeResult): EvaluationResult {
        return {
            testCase: { id: 'a', category: 'basic', query: 'q', reference: 'r' } as EvaluationResult['testCase'],
            conversation: makeConversation([{ turnNumber: 1, toolCalls: [], toolResults: [] }]),
            judgeResult,
            durationMs: 100,
        };
    }

    it('prints every dimension verdict with its reason', () => {
        const output = formatDetailedResult(
            makeVerboseResult(
                makeJudgeResult({
                    rubric: makeRubric({ resultUtilization: { verdict: 'FAIL', reason: 'misread the dataset' } }),
                }),
            ),
        );
        expect(output).toContain('✓ Tool selection: ok');
        expect(output).toContain('✗ Result utilization: misread the dataset');
    });

    it('prints both deterministic check results', () => {
        const output = formatDetailedResult(
            makeVerboseResult(
                makeJudgeResult({
                    toolSelectionCheck: {
                        checked: true,
                        verdict: 'FAIL',
                        expected: ['call-actor'],
                        actual: ['call-actor', 'search-actors'],
                    },
                    schemaValidityCheck: {
                        verdict: 'FAIL',
                        invalidCalls: [{ toolName: 'call-actor', errors: ["must have required property 'actor'"] }],
                    },
                }),
            ),
        );
        expect(output).toContain('Tool selection: FAIL');
        expect(output).toContain('Expected: [call-actor]');
        expect(output).toContain('Actual:   [call-actor, search-actors]');
        expect(output).toContain('Schema validity: FAIL');
        expect(output).toContain("call-actor: must have required property 'actor'");
    });

    it('says tool selection was not checked when the test case declares no expectedTools', () => {
        const output = formatDetailedResult(makeVerboseResult(makeJudgeResult()));
        expect(output).toContain('not checked (no expectedTools on this test case)');
    });
});
