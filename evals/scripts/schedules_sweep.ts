/**
 * Which schedules the `merge/schedules/*` eval teardown deletes. Split from `schedules_fixtures.ts`,
 * which loads `dotenv` at import time, so a unit test can import this without those side effects.
 */

import { isNameFromRun } from '../run_id.js';

/** Only schedules with this prefix are ever deleted. */
export const EVAL_SCHEDULE_PREFIX = 'eval-';

/** The one permanent fixture: reset every run, never deleted, never modified by a case. */
export const FIXTURE_SCHEDULE_NAME = 'eval-nightly-sum';

/**
 * How old an unmatched `eval-*` schedule must be before the sweep deletes it. Four times the
 * workflow's 90-minute timeout, so a run in flight never loses a schedule it is asserting on.
 */
export const LEFTOVER_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export type SweepCandidate = { name: string; createdAt: Date | string };

export function isSweepableSchedule(schedule: SweepCandidate, runId: string | undefined, now: number): boolean {
    const { name } = schedule;
    if (name === FIXTURE_SCHEDULE_NAME || !name.startsWith(EVAL_SCHEDULE_PREFIX)) return false;
    if (runId && isNameFromRun(name, runId)) return true;
    return now - new Date(schedule.createdAt).getTime() >= LEFTOVER_MAX_AGE_MS;
}
