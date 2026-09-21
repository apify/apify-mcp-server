/**
 * Which schedules the `merge/schedules/*` eval teardown deletes.
 *
 * Side-effect free on purpose: `schedules_fixtures.ts` loads `dotenv` and sanitizes `process.env`
 * at import time, so the predicate and its constants live here where a unit test can import them
 * without that happening.
 */

import { isNameFromRun } from '../run_id.js';

/** Only schedules with this prefix are ever deleted. */
export const EVAL_SCHEDULE_PREFIX = 'eval-';

/**
 * The one permanent fixture, reset every run and never deleted. Target of pure get-schedule cases;
 * no case may modify it. Cases that create or edit a schedule build their own, named after the run
 * and trial that created them (see `run_id.ts`).
 */
export const FIXTURE_SCHEDULE_NAME = 'eval-nightly-sum';

/**
 * How old an unmatched `eval-*` schedule must be before the sweep deletes it. Four times the
 * workflow's 90-minute timeout, so a run in flight never loses a schedule it is still asserting
 * on; a crashed run's enabled schedules keep firing until then.
 */
export const LEFTOVER_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** What the sweep reads off a listed schedule. */
export type SweepCandidate = { name: string; createdAt: Date | string };

/**
 * Whether the sweep deletes this schedule: the run-id token matches at any age, an unmatched
 * `eval-*` leftover only once it is older than the age limit. The fixture and anything outside the
 * `eval-` prefix are never deleted.
 */
export function isSweepableSchedule(schedule: SweepCandidate, runId: string | undefined, now: number): boolean {
    const { name } = schedule;
    if (name === FIXTURE_SCHEDULE_NAME || !name.startsWith(EVAL_SCHEDULE_PREFIX)) return false;
    if (runId && isNameFromRun(name, runId)) return true;
    return now - new Date(schedule.createdAt).getTime() >= LEFTOVER_MAX_AGE_MS;
}
