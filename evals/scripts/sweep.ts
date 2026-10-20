/**
 * Which `eval-*` schedules and tasks the fixtures script deletes. Split from `fixtures.ts`, which
 * loads `dotenv` at import time, so a unit test can import this without that side effect.
 */

import { isNameFromRun } from '../run_id.js';

/** Only schedules and tasks with this prefix are ever deleted. */
export const EVAL_PREFIX = 'eval-';

/** Permanent read-only fixture task, target of pure get-actor-task cases. Reset every run, never deleted. */
export const FIXTURE_TASK_NAME = 'eval-sum-nightly';

/** Permanent read-only fixture schedule: reset every run, never deleted, never modified by a case. */
export const FIXTURE_SCHEDULE_NAME = 'eval-nightly-sum';

/**
 * How old an `eval-*` schedule or task must be before the seed sweep deletes it. Four times the
 * workflow's 90-minute timeout, so a run in flight never loses a schedule or task it is asserting on.
 */
export const LEFTOVER_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export type SweepCandidate = { name: string; createdAt: Date | string };

/** With a run id, only that run's names; without one, every `eval-*` leftover past the age limit. */
export function isSweepable({ name, createdAt }: SweepCandidate, runId: string | undefined, now: number): boolean {
    if (name === FIXTURE_TASK_NAME || name === FIXTURE_SCHEDULE_NAME || !name.startsWith(EVAL_PREFIX)) return false;
    if (runId) return isNameFromRun(name, runId);
    return now - new Date(createdAt).getTime() >= LEFTOVER_MAX_AGE_MS;
}
