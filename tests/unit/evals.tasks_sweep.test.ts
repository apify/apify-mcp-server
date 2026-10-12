import { describe, expect, it } from 'vitest';

import { buildRunSuffix } from '../../evals/run_id.js';
import { isSweepableTask } from '../../evals/scripts/tasks_sweep.js';

const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);
const MINUTES_AGO_12 = new Date(NOW - 12 * 60 * 1000);
const HOURS_AGO_6 = new Date(NOW - 6 * 60 * 60 * 1000);
const JUST_UNDER_HOURS_AGO_6 = new Date(NOW - 6 * 60 * 60 * 1000 + 1);
const HOURS_AGO_9 = new Date(NOW - 9 * 60 * 60 * 1000);
const DAYS_AGO_3 = new Date(NOW - 3 * 24 * 60 * 60 * 1000);
const WEEKS_AGO_3 = new Date(NOW - 21 * 24 * 60 * 60 * 1000);
const RUN_ID = '35014680476-1';
const OTHER_RUN_TASK_NAME = `eval-sum-daily-${buildRunSuffix('35014680999-1', 1, 1)}`;

describe('isSweepableTask()', () => {
    it('deletes a task this run created, however young', () => {
        expect(
            isSweepableTask(
                { name: `eval-sum-daily-${buildRunSuffix(RUN_ID, 1, 1)}`, createdAt: MINUTES_AGO_12 },
                RUN_ID,
                NOW,
            ),
        ).toBe(true);
    });

    it('deletes a task this run created that is also past the age limit', () => {
        expect(
            isSweepableTask(
                { name: `eval-sum-daily-${buildRunSuffix(RUN_ID, 2, 1)}`, createdAt: HOURS_AGO_9 },
                RUN_ID,
                NOW,
            ),
        ).toBe(true);
    });

    it('keeps a young task from a run id this one only prefixes', () => {
        expect(
            isSweepableTask(
                { name: `eval-sum-daily-${buildRunSuffix('35014680476-12', 1, 1)}`, createdAt: MINUTES_AGO_12 },
                RUN_ID,
                NOW,
            ),
        ).toBe(false);
    });

    it('keeps a young leftover from another run', () => {
        expect(isSweepableTask({ name: OTHER_RUN_TASK_NAME, createdAt: MINUTES_AGO_12 }, RUN_ID, NOW)).toBe(false);
    });

    it('keeps an old task from another run during run-specific teardown', () => {
        expect(isSweepableTask({ name: OTHER_RUN_TASK_NAME, createdAt: HOURS_AGO_9 }, RUN_ID, NOW)).toBe(false);
        expect(isSweepableTask({ name: 'eval-sum-weekly', createdAt: DAYS_AGO_3 }, RUN_ID, NOW)).toBe(false);
    });

    it('deletes a leftover older than the age limit', () => {
        expect(isSweepableTask({ name: 'eval-sum-weekly', createdAt: DAYS_AGO_3 }, undefined, NOW)).toBe(true);
    });

    it('applies the age limit alone when no run id is given', () => {
        expect(isSweepableTask({ name: OTHER_RUN_TASK_NAME, createdAt: MINUTES_AGO_12 }, undefined, NOW)).toBe(false);
        expect(isSweepableTask({ name: OTHER_RUN_TASK_NAME, createdAt: HOURS_AGO_9 }, undefined, NOW)).toBe(true);
    });

    it('deletes a leftover exactly at the age limit and keeps one just under it', () => {
        expect(isSweepableTask({ name: OTHER_RUN_TASK_NAME, createdAt: HOURS_AGO_6 }, undefined, NOW)).toBe(true);
        expect(isSweepableTask({ name: OTHER_RUN_TASK_NAME, createdAt: JUST_UNDER_HOURS_AGO_6 }, undefined, NOW)).toBe(
            false,
        );
    });

    it('keeps the read-only fixture at any age', () => {
        expect(isSweepableTask({ name: 'eval-sum-nightly', createdAt: WEEKS_AGO_3 }, RUN_ID, NOW)).toBe(false);
        expect(isSweepableTask({ name: 'eval-sum-nightly', createdAt: WEEKS_AGO_3 }, undefined, NOW)).toBe(false);
    });

    it('keeps a task outside the eval prefix at any age', () => {
        expect(isSweepableTask({ name: 'test-task-3k9f2q-update', createdAt: WEEKS_AGO_3 }, RUN_ID, NOW)).toBe(false);
        expect(isSweepableTask({ name: 'test-task-3k9f2q-update', createdAt: WEEKS_AGO_3 }, undefined, NOW)).toBe(
            false,
        );
    });

    it('reads an ISO createdAt string as well as a Date', () => {
        expect(
            isSweepableTask({ name: OTHER_RUN_TASK_NAME, createdAt: HOURS_AGO_9.toISOString() }, undefined, NOW),
        ).toBe(true);
    });
});
