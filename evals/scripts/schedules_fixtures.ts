#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Fixtures for the `merge/schedules/*` agent evals (schedule-tool cases).
 *
 * Deletes the schedules a run left behind and resets the one permanent read-only fixture, which it
 * creates if missing (an eval agent may have enabled it or replaced its actions). Two delete rules:
 *
 * - `--run-id <id>`: every `eval-*` schedule whose name carries that run's `-<id>-t<trial>` token,
 *   whatever its age. This is the teardown of one finished run, and the only rule that runs
 *   immediately after it.
 * - The age backstop: an `eval-*` schedule no `--run-id` matched is deleted once it is older than
 *   `LEFTOVER_MAX_AGE_MS`. A younger one may belong to a run still asserting on it, and this script
 *   deletes on whatever account `APIFY_TOKEN` points at.
 *
 * `tasks_fixtures.ts` still sweeps by prefix alone, without the age or run-id rules; see #1394.
 *
 * The fixture schedule runs the task fixture from `tasks_fixtures.ts`, so run that first:
 *   pnpm run evals:mcp-agent:tasks-fixtures && pnpm run evals:mcp-agent:schedules-fixtures [--run-id <id>] [--dry-run]
 */

import 'dotenv/config';

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ApifyClient, type ScheduleCreateOrUpdateData, ScheduleActions } from 'apify-client';

import { findMissingEnvVars, sanitizeProcessEnv } from '../environment.js';
import { isNameFromRun, validateRunId } from '../run_id.js';

sanitizeProcessEnv();

/** Only schedules with this prefix are ever deleted. */
const EVAL_SCHEDULE_PREFIX = 'eval-';

/**
 * The one permanent fixture, reset every run and never deleted. Target of pure get-schedule cases;
 * no case may modify it. Cases that create or edit a schedule build their own, named after the run
 * and trial that created them (see `run_id.ts`).
 */
const FIXTURE_SCHEDULE_NAME = 'eval-nightly-sum';

/**
 * How old an unmatched `eval-*` schedule must be before the sweep deletes it. An order of magnitude
 * above the longest plausible merge run (the workflow times out at 90 minutes), so a run in flight
 * never loses a schedule it is still asserting on; a crashed run's enabled schedules keep firing
 * until then.
 */
const LEFTOVER_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** The task fixture seeded by `tasks_fixtures.ts`; the only action on the fixture schedule. */
const FIXTURE_TASK_NAME = 'eval-sum-nightly';

/** Disabled on purpose: an enabled fixture would start a run on the eval account every night. */
const FIXTURE_SCHEDULE = {
    cronExpression: '0 3 * * *',
    timezone: 'UTC' as const,
    isEnabled: false,
    isExclusive: true,
};

/** `--dry-run` prints what the run would change and writes nothing. */
const IS_DRY_RUN = process.argv.includes('--dry-run');
/** Marks every line of a dry run, so its output cannot be read as changes that happened. */
const DRY = IS_DRY_RUN ? '[dry run] ' : '';

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

/** `--run-id <id>`, parsed by hand like `--dry-run`; the eval CLI layer uses no framework. */
function parseRunIdArg(argv: string[]): string | undefined {
    const index = argv.indexOf('--run-id');
    if (index === -1) return undefined;
    const value = argv[index + 1];
    try {
        if (!value) throw new Error('--run-id needs a value');
        validateRunId(value);
    } catch (error) {
        console.error(`❌ Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
    return value;
}

async function main() {
    const runId = parseRunIdArg(process.argv);
    const missing = findMissingEnvVars(['APIFY_TOKEN']);
    if (missing.length > 0) {
        console.error(`❌ Error: missing environment variable(s): ${missing.join(', ')}`);
        process.exit(1);
    }
    const client = new ApifyClient({ token: process.env.APIFY_TOKEN });

    // The deletes below hit whatever account APIFY_TOKEN points at, so name it first.
    console.log(`👤 ${DRY}Account: ${(await client.user('me').get()).username ?? 'unknown'}`);
    if (runId) console.log(`🧹 ${DRY}Tearing down run "${runId}" plus leftovers older than 6h`);

    const fixtureTask = await client.task(`~${FIXTURE_TASK_NAME}`).get();
    if (!fixtureTask) {
        console.error(
            `❌ Error: fixture task "${FIXTURE_TASK_NAME}" not found; run evals:mcp-agent:tasks-fixtures first`,
        );
        process.exit(1);
    }
    // Annotated, not inferred: an array literal widens `type` to the whole enum, which the
    // client's discriminated action union rejects.
    const actions: ScheduleCreateOrUpdateData['actions'] = [
        { type: ScheduleActions.RunActorTask, actorTaskId: fixtureTask.id },
    ];

    // Read every page before deleting anything: offset paging skips entries when the
    // collection shrinks underneath it, and a missed leftover fails the next run.
    const schedules = [];
    for await (const schedule of client.schedules().list()) schedules.push(schedule);

    const now = Date.now();
    let fixtureId: string | undefined;
    for (const schedule of schedules) {
        if (schedule.name === FIXTURE_SCHEDULE_NAME) {
            fixtureId = schedule.id;
            continue;
        }
        if (!isSweepableSchedule(schedule, runId, now)) continue;
        if (!IS_DRY_RUN) await client.schedule(schedule.id).delete();
        console.log(`🗑️  ${DRY}Deleted leftover schedule "${schedule.name}" (${schedule.id})`);
    }

    const fields = {
        ...FIXTURE_SCHEDULE,
        title: 'Eval fixture (read-only)',
        description: 'Permanent fixture for schedule-tool MCP agent evals. Do not delete; do not modify.',
        actions,
    };
    if (fixtureId) {
        // Reset everything an eval agent may have changed: enabled state, cadence, actions.
        if (!IS_DRY_RUN) await client.schedule(fixtureId).update(fields);
        console.log(`♻️  ${DRY}Reset fixture schedule "${FIXTURE_SCHEDULE_NAME}" (${fixtureId})`);
    } else if (IS_DRY_RUN) {
        console.log(`🌱 ${DRY}Created fixture schedule "${FIXTURE_SCHEDULE_NAME}"`);
    } else {
        const schedule = await client.schedules().create({ ...fields, name: FIXTURE_SCHEDULE_NAME });
        console.log(`🌱 Created fixture schedule "${schedule.name}" (${schedule.id})`);
    }

    console.log(IS_DRY_RUN ? '✅ Dry run complete, nothing changed' : '✅ Schedule fixtures ready');
}

// CLI only: the unit test imports `isSweepableSchedule` from here, and an unconditional call would
// run the sweep against the account on import.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
