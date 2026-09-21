import { describe, expect, it } from 'vitest';

import { isSweepableSchedule } from '../../evals/scripts/schedules_sweep.js';

const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);
const MINUTES_AGO_12 = new Date(NOW - 12 * 60 * 1000);
const HOURS_AGO_9 = new Date(NOW - 9 * 60 * 60 * 1000);
const WEEKS_AGO_3 = new Date(NOW - 21 * 24 * 60 * 60 * 1000);
const RUN_ID = '35014680476-1';

describe('isSweepableSchedule()', () => {
    it('deletes a schedule this run created, however young', () => {
        expect(
            isSweepableSchedule({ name: 'eval-sched-add-35014680476-1-t1', createdAt: MINUTES_AGO_12 }, RUN_ID, NOW),
        ).toBe(true);
    });

    it('deletes a schedule this run created that is also past the age limit', () => {
        expect(
            isSweepableSchedule({ name: 'eval-sched-add-35014680476-1-t2', createdAt: HOURS_AGO_9 }, RUN_ID, NOW),
        ).toBe(true);
    });

    it('keeps a young schedule from a run id this one only prefixes', () => {
        expect(
            isSweepableSchedule({ name: 'eval-sched-add-35014680476-12-t1', createdAt: MINUTES_AGO_12 }, RUN_ID, NOW),
        ).toBe(false);
    });

    it('keeps a young leftover from another run', () => {
        expect(
            isSweepableSchedule({ name: 'eval-sched-daily-r8m1p4bz2q-t1', createdAt: MINUTES_AGO_12 }, RUN_ID, NOW),
        ).toBe(false);
    });

    it('deletes a leftover older than the age limit', () => {
        expect(
            isSweepableSchedule({ name: 'eval-sched-daily-r8m1p4bz2q-t1', createdAt: HOURS_AGO_9 }, RUN_ID, NOW),
        ).toBe(true);
    });

    it('applies the age limit alone when no run id is given', () => {
        expect(
            isSweepableSchedule({ name: 'eval-sched-daily-r8m1p4bz2q-t1', createdAt: MINUTES_AGO_12 }, undefined, NOW),
        ).toBe(false);
        expect(
            isSweepableSchedule({ name: 'eval-sched-daily-r8m1p4bz2q-t1', createdAt: HOURS_AGO_9 }, undefined, NOW),
        ).toBe(true);
    });

    it('keeps the read-only fixture at any age', () => {
        expect(isSweepableSchedule({ name: 'eval-nightly-sum', createdAt: WEEKS_AGO_3 }, RUN_ID, NOW)).toBe(false);
    });

    it('keeps a schedule outside the eval prefix at any age', () => {
        expect(isSweepableSchedule({ name: 'test-sched-3k9f2q-update', createdAt: WEEKS_AGO_3 }, RUN_ID, NOW)).toBe(
            false,
        );
    });

    it('reads an ISO createdAt string as well as a Date', () => {
        expect(
            isSweepableSchedule(
                { name: 'eval-sched-daily-r8m1p4bz2q-t1', createdAt: HOURS_AGO_9.toISOString() },
                RUN_ID,
                NOW,
            ),
        ).toBe(true);
    });
});
