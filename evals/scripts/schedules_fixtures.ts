#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Fixtures for the `merge/schedules/*` agent evals (schedule-tool cases).
 *
 * Deletes the schedules a run left behind (delete rules in `schedules_sweep.ts`) and resets the one
 * permanent read-only fixture, creating it if missing.
 *
 * `tasks_fixtures.ts` still sweeps by prefix alone; see #1394.
 *
 * The fixture schedule runs the task fixture from `tasks_fixtures.ts`, so run that first:
 *   pnpm run evals:mcp-agent:tasks-fixtures && pnpm run evals:mcp-agent:schedules-fixtures [--run-id <id>] [--dry-run]
 */

import 'dotenv/config';

import { ApifyClient, type ScheduleCreateOrUpdateData, ScheduleActions } from 'apify-client';

import { findMissingEnvVars, sanitizeProcessEnv } from '../environment.js';
import { parseRunIdArg } from '../run_id.js';
import { FIXTURE_SCHEDULE_NAME, isSweepableSchedule } from './schedules_sweep.js';

sanitizeProcessEnv();

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

async function main() {
    let runId: string | undefined;
    try {
        runId = parseRunIdArg(process.argv);
    } catch (error) {
        console.error(`❌ Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
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

void main();
