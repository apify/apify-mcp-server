/**
 * Which tasks the `merge/tasks/*` eval fixtures script deletes. Split from `tasks_fixtures.ts`,
 * which has side effects at import time, so a unit test can import this without them.
 */

import { isNameFromRun } from '../run_id.js';
import { LEFTOVER_MAX_AGE_MS, type SweepCandidate } from './schedules_sweep.js';

/** Only tasks with this prefix are ever deleted. */
export const EVAL_TASK_PREFIX = 'eval-';

/** Permanent read-only fixture, target of pure get-actor-task cases. Never deleted. */
export const FIXTURE_TASK_NAME = 'eval-sum-nightly';

export function isSweepableTask(task: SweepCandidate, runId: string | undefined, now: number): boolean {
    const { name } = task;
    if (name === FIXTURE_TASK_NAME || !name.startsWith(EVAL_TASK_PREFIX)) return false;
    if (runId) return isNameFromRun(name, runId);
    return now - new Date(task.createdAt).getTime() >= LEFTOVER_MAX_AGE_MS;
}
