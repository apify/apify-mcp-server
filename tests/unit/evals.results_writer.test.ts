import { describe, expect, it } from 'vitest';

import type { ResultsDatabase, TestResultRecord } from '../../evals/workflows/output_formatter.js';
import { buildResultKey, findBaselineRecord } from '../../evals/workflows/results_writer.js';

function makeRecord(overrides: Partial<TestResultRecord>): TestResultRecord {
    return {
        timestamp: '2026-01-01T00:00:00.000Z',
        agentModel: 'agent',
        judgeModel: 'judge',
        testId: 'test',
        verdict: 'PASS',
        reason: 'ok',
        durationMs: 100,
        turns: 1,
        resultBytes: 1000,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 500,
        error: null,
        ...overrides,
    };
}

function makeDatabase(records: TestResultRecord[]): ResultsDatabase {
    const results: ResultsDatabase['results'] = {};
    for (const record of records) {
        results[buildResultKey(record.agentModel, record.judgeModel, record.testId)] = record;
    }
    return { version: '1.0', results };
}

describe('findBaselineRecord()', () => {
    it('matches by agent model and test ID regardless of the judge model', () => {
        const database = makeDatabase([makeRecord({ judgeModel: 'grok', resultBytes: 2000 })]);
        // Baseline was recorded with judge "grok"; the run uses judge "deepseek".
        const record = findBaselineRecord(database, 'agent', 'test');
        expect(record?.resultBytes).toBe(2000);
    });

    it('returns undefined when no record matches the agent model', () => {
        const database = makeDatabase([makeRecord({ agentModel: 'other-agent' })]);
        expect(findBaselineRecord(database, 'agent', 'test')).toBeUndefined();
    });

    it('returns undefined when no record matches the test ID', () => {
        const database = makeDatabase([makeRecord({ testId: 'other-test' })]);
        expect(findBaselineRecord(database, 'agent', 'test')).toBeUndefined();
    });

    it('prefers a metrics-bearing record over an older null-metrics one for the same agent+test', () => {
        const database = makeDatabase([
            // Older record from before the metrics feature (judge "grok"), appears first.
            makeRecord({
                judgeModel: 'grok',
                timestamp: '2026-01-01T00:00:00.000Z',
                resultBytes: undefined,
                totalTokens: undefined,
            }),
            // Fresh record with metrics (judge "deepseek"), appended later.
            makeRecord({ judgeModel: 'deepseek', timestamp: '2026-06-01T00:00:00.000Z', resultBytes: 1234 }),
        ]);
        expect(findBaselineRecord(database, 'agent', 'test')?.resultBytes).toBe(1234);
    });

    it('prefers the newest record when several carry metrics', () => {
        const database = makeDatabase([
            makeRecord({ judgeModel: 'grok', timestamp: '2026-01-01T00:00:00.000Z', resultBytes: 1000 }),
            makeRecord({ judgeModel: 'deepseek', timestamp: '2026-06-01T00:00:00.000Z', resultBytes: 3000 }),
        ]);
        expect(findBaselineRecord(database, 'agent', 'test')?.resultBytes).toBe(3000);
    });
});
