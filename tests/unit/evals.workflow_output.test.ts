import { describe, expect, it } from 'vitest';

import type { TrialOutcome } from '../../evals/workflows/output_formatter.js';
import { formatResultsTable, isPass, summarize } from '../../evals/workflows/output_formatter.js';

function outcome(overrides: Partial<TrialOutcome> = {}): TrialOutcome {
    return { id: 'test', category: 'search', reward: 1, reason: 'ok', ...overrides };
}

describe('isPass()', () => {
    it('is true only for a reward of exactly 1', () => {
        expect(isPass(outcome({ reward: 1 }))).toBe(true);
        expect(isPass(outcome({ reward: 0 }))).toBe(false);
        expect(isPass(outcome({ reward: null }))).toBe(false);
    });
});

describe('summarize()', () => {
    it('counts passed, failed, and errored (null reward) trials', () => {
        const totals = summarize([
            outcome({ id: 'a', reward: 1 }),
            outcome({ id: 'b', reward: 0 }),
            outcome({ id: 'c', reward: null }),
        ]);
        expect(totals).toEqual({ total: 3, passed: 1, failed: 1, errored: 1 });
    });

    it('returns all-zero for no outcomes', () => {
        expect(summarize([])).toEqual({ total: 0, passed: 0, failed: 0, errored: 0 });
    });
});

describe('formatResultsTable()', () => {
    it('shows a status and reason per trial', () => {
        const table = formatResultsTable([outcome({ id: 'a', reward: 1, reason: 'good' })]);
        expect(table).toContain('✅ PASS | a | search');
        expect(table).toContain('Reason: good');
    });

    it('marks a null-reward trial as an error', () => {
        const table = formatResultsTable([outcome({ id: 'a', reward: null, reason: 'no reward' })]);
        expect(table).toContain('🔥 ERROR | a');
    });

    it('lists skipped cases and counts them in the summary', () => {
        const table = formatResultsTable([outcome({ id: 'a' })], ['report-problem-on-tool-error']);
        expect(table).toContain('⏭️  SKIPPED | report-problem-on-tool-error');
        expect(table).toContain('Skipped: 1');
    });

    it('reports overall PASS only when every executed trial passed', () => {
        expect(formatResultsTable([outcome({ reward: 1 })])).toContain('✅ Overall: PASS');
        expect(formatResultsTable([outcome({ reward: 0 })])).toContain('❌ Overall: FAIL');
    });

    it('shows "no trials executed" for an empty run and never reports PASS', () => {
        const table = formatResultsTable([]);
        expect(table).toContain('No trials executed');
        expect(table).not.toContain('Overall: PASS');
    });
});
