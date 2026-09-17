#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Fixtures for the `merge/schedules/*` agent evals (schedule-tool cases).
 *
 * Deletes schedules named `eval-*` left behind by previous runs, except the one permanent
 * read-only fixture schedule, which it creates if missing and resets otherwise (an eval agent
 * may have enabled it or replaced its actions). Schedule names are unique per account, so the
 * fixed-name create cases collide with leftovers on the next run without this.
 *
 * The fixture schedule runs the task fixture from `tasks_fixtures.ts`, so run that first:
 *   pnpm run evals:mcp-agent:tasks-fixtures && pnpm run evals:mcp-agent:schedules-fixtures [--dry-run]
 */

import 'dotenv/config';

import { ApifyClient, type ScheduleCreateOrUpdateData, ScheduleActions } from 'apify-client';

import { findMissingEnvVars, sanitizeProcessEnv } from '../environment.js';

sanitizeProcessEnv();

/** Only schedules with this prefix are ever deleted. */
const EVAL_SCHEDULE_PREFIX = 'eval-';

/** Permanent read-only fixture, target of pure get-schedule cases. Never deleted, reset every run. */
const FIXTURE_SCHEDULE_NAME = 'eval-nightly-sum';
/** The task fixture seeded by `tasks_fixtures.ts`; the fixture schedule's only action. */
const FIXTURE_TASK_NAME = 'eval-sum-nightly';
/** Disabled on purpose: an enabled fixture would start a run on the eval account every night. */
const FIXTURE_SCHEDULE = {
    title: 'Eval fixture (read-only)',
    description: 'Permanent fixture for schedule-tool MCP agent evals. Do not modify or delete.',
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
    const missing = findMissingEnvVars(['APIFY_TOKEN']);
    if (missing.length > 0) {
        console.error(`❌ Error: missing environment variable(s): ${missing.join(', ')}`);
        process.exit(1);
    }
    const client = new ApifyClient({ token: process.env.APIFY_TOKEN });

    // The deletes below hit whatever account APIFY_TOKEN points at, so name it first.
    console.log(`👤 ${DRY}Account: ${(await client.user('me').get()).username ?? 'unknown'}`);

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

    let fixture;
    for (const schedule of schedules) {
        if (schedule.name === FIXTURE_SCHEDULE_NAME) {
            fixture = schedule;
            continue;
        }
        if (schedule.name.startsWith(EVAL_SCHEDULE_PREFIX)) {
            if (!IS_DRY_RUN) await client.schedule(schedule.id).delete();
            console.log(`🗑️  ${DRY}Deleted leftover schedule "${schedule.name}" (${schedule.id})`);
        }
    }

    if (fixture) {
        // Reset everything an eval agent may have changed: enabled state, cadence, actions.
        if (!IS_DRY_RUN) await client.schedule(fixture.id).update({ ...FIXTURE_SCHEDULE, actions });
        console.log(`♻️  ${DRY}Reset fixture schedule "${fixture.name}" (${fixture.id})`);
    } else if (IS_DRY_RUN) {
        console.log(`🌱 ${DRY}Created fixture schedule "${FIXTURE_SCHEDULE_NAME}"`);
    } else {
        const schedule = await client.schedules().create({ ...FIXTURE_SCHEDULE, name: FIXTURE_SCHEDULE_NAME, actions });
        console.log(`🌱 Created fixture schedule "${schedule.name}" (${schedule.id})`);
    }

    console.log(IS_DRY_RUN ? '✅ Dry run complete, nothing changed' : '✅ Schedule fixtures ready');
}

void main();
