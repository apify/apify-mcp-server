import { describe, expect, it } from 'vitest';

import { buildRunSuffix } from '../../evals/run_id.js';
import { isSweepable } from '../../evals/scripts/sweep.js';

const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);
const MINUTES_AGO_12 = new Date(NOW - 12 * 60 * 1000);
const HOURS_AGO_9 = new Date(NOW - 9 * 60 * 60 * 1000);
const WEEKS_AGO_3 = new Date(NOW - 21 * 24 * 60 * 60 * 1000);
const RUN_ID = '35014680476-1';
const OTHER_RUN_NAME = `eval-sum-daily-${buildRunSuffix('35014680999-1', 1, 1)}`;

describe('isSweepable()', () => {
    it('deletes a resource this run created, however young', () => {
        expect(
            isSweepable(
                { name: `eval-sched-add-${buildRunSuffix(RUN_ID, 1, 1)}`, createdAt: MINUTES_AGO_12 },
                RUN_ID,
                NOW,
            ),
        ).toBe(true);
    });

    it('deletes a resource this run created that is also past the age limit', () => {
        expect(
            isSweepable(
                { name: `eval-sum-daily-${buildRunSuffix(RUN_ID, 2, 1)}`, createdAt: HOURS_AGO_9 },
                RUN_ID,
                NOW,
            ),
        ).toBe(true);
    });

    it('keeps a young resource from a run id this one only prefixes', () => {
        expect(
            isSweepable(
                { name: `eval-sched-add-${buildRunSuffix('35014680476-12', 1, 1)}`, createdAt: MINUTES_AGO_12 },
                RUN_ID,
                NOW,
            ),
        ).toBe(false);
    });

    it('keeps a leftover from another run at any age during run-specific teardown', () => {
        expect(isSweepable({ name: OTHER_RUN_NAME, createdAt: MINUTES_AGO_12 }, RUN_ID, NOW)).toBe(false);
        expect(isSweepable({ name: 'eval-sched-target', createdAt: HOURS_AGO_9 }, RUN_ID, NOW)).toBe(false);
    });

    it('applies the age limit alone when no run id is given', () => {
        expect(isSweepable({ name: OTHER_RUN_NAME, createdAt: MINUTES_AGO_12 }, undefined, NOW)).toBe(false);
        expect(isSweepable({ name: OTHER_RUN_NAME, createdAt: HOURS_AGO_9 }, undefined, NOW)).toBe(true);
    });

    it('keeps both read-only fixtures at any age', () => {
        for (const name of ['eval-sum-nightly', 'eval-nightly-sum']) {
            expect(isSweepable({ name, createdAt: WEEKS_AGO_3 }, RUN_ID, NOW)).toBe(false);
            expect(isSweepable({ name, createdAt: WEEKS_AGO_3 }, undefined, NOW)).toBe(false);
        }
    });

    it('keeps a resource outside the eval prefix at any age', () => {
        expect(isSweepable({ name: 'test-sched-3k9f2q-update', createdAt: WEEKS_AGO_3 }, RUN_ID, NOW)).toBe(false);
        expect(isSweepable({ name: 'test-sched-3k9f2q-update', createdAt: WEEKS_AGO_3 }, undefined, NOW)).toBe(false);
    });

    it('reads an ISO createdAt string as well as a Date', () => {
        expect(isSweepable({ name: OTHER_RUN_NAME, createdAt: HOURS_AGO_9.toISOString() }, undefined, NOW)).toBe(true);
    });
});
