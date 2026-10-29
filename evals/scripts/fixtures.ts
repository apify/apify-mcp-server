#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Fixtures for the `merge/tasks/*`, `merge/schedules/*` and `merge/storage/*` agent evals.
 *
 * Deletes the schedules and tasks a run left behind (delete rule in `sweep.ts`), then resets the
 * two permanent read-only task and schedule fixtures, creating them if missing. Schedules go before
 * tasks and the task fixture before the schedule fixture, because the fixture schedule runs the
 * fixture task. Last, seeds the named dataset and key-value store fixtures if their content is missing.
 *
 * Usage: pnpm run evals:mcp-agent:fixtures [--run-id <id>] [--dry-run]
 */

import 'dotenv/config';

import { ApifyClient, type ScheduleCreateOrUpdateData, ScheduleActions } from 'apify-client';

import { findMissingEnvVars, sanitizeProcessEnv } from '../environment.js';
import { parseRunIdArg } from '../run_id.js';
import { FIXTURE_SCHEDULE_NAME, FIXTURE_TASK_NAME, isSweepable, type SweepCandidate } from './sweep.js';

sanitizeProcessEnv();

const FIXTURE_ACTOR = 'apify/normal-mode-test-actor';
const FIXTURE_TASK_INPUT = { firstNumber: 1, secondNumber: 2 };

/** Disabled on purpose: an enabled fixture would start a run on the eval account every night. */
const FIXTURE_SCHEDULE = {
    cronExpression: '0 3 * * *',
    timezone: 'UTC' as const,
    isEnabled: false,
    isExclusive: true,
};

/**
 * Permanent read-only fixtures for the `merge/storage/*` cases, which address them by bare name.
 * The storage tools only read, so no case can change them and they are seeded once, never reset.
 */
const FIXTURE_DATASET_NAME = 'eval-storage-products';
const FIXTURE_DATASET_ITEMS = [
    { name: 'Aeropress Go', priceUsd: 39.95 },
    { name: 'Hario V60', priceUsd: 27.5 },
    { name: 'Chemex Classic', priceUsd: 49 },
];
const FIXTURE_KEY_VALUE_STORE_NAME = 'eval-storage-settings';
const FIXTURE_RECORD = { key: 'CONFIG', value: { currency: 'EUR', maxResults: 25 } };

/** `--dry-run` prints what the run would change and writes nothing. */
const IS_DRY_RUN = process.argv.includes('--dry-run');
/** Marks every line of a dry run, so its output cannot be read as changes that happened. */
const DRY = IS_DRY_RUN ? '[dry run] ' : '';

type Resource = SweepCandidate & { id: string };

/** Deletes every sweepable item from `list` and returns the fixture if it is there. */
async function sweep(
    kind: string,
    list: AsyncIterable<Resource>,
    fixtureName: string,
    runId: string | undefined,
    remove: (id: string) => Promise<void>,
): Promise<Resource | undefined> {
    // Read every page before deleting anything: offset paging skips entries when the
    // collection shrinks underneath it, and a missed leftover fails the next run.
    const items = [];
    for await (const item of list) items.push(item);

    const now = Date.now();
    for (const item of items) {
        if (!isSweepable(item, runId, now)) continue;
        if (!IS_DRY_RUN) await remove(item.id);
        console.log(`🗑️  ${DRY}Deleted leftover ${kind} "${item.name}" (${item.id})`);
    }
    return items.find((item) => item.name === fixtureName);
}

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
    if (runId) console.log(`🧹 ${DRY}Tearing down run "${runId}"`);

    const schedule = await sweep('schedule', client.schedules().list(), FIXTURE_SCHEDULE_NAME, runId, async (id) =>
        client.schedule(id).delete(),
    );
    let task = await sweep('task', client.tasks().list(), FIXTURE_TASK_NAME, runId, async (id) =>
        client.task(id).delete(),
    );

    // Reset the input: an eval agent may have mutated the fixture (e.g. resolving a
    // name collision by updating the existing task).
    if (task) {
        if (!IS_DRY_RUN) await client.task(task.id).update({ input: FIXTURE_TASK_INPUT });
        console.log(`♻️  ${DRY}Reset fixture task "${FIXTURE_TASK_NAME}" (${task.id})`);
    } else {
        if (!IS_DRY_RUN) {
            const actor = await client.actor(FIXTURE_ACTOR).get();
            if (!actor) throw new Error(`Fixture Actor "${FIXTURE_ACTOR}" not found`);
            task = await client.tasks().create({
                actId: actor.id,
                name: FIXTURE_TASK_NAME,
                title: 'Eval fixture (read-only)',
                description: 'Permanent fixture for task-tool MCP agent evals. Do not modify or delete.',
                input: FIXTURE_TASK_INPUT,
            });
        }
        console.log(`🌱 ${DRY}Created fixture task "${FIXTURE_TASK_NAME}"${task ? ` (${task.id})` : ''}`);
    }

    // Annotated, not inferred: an array literal widens `type` to the whole enum, which the
    // client's discriminated action union rejects.
    const actions: ScheduleCreateOrUpdateData['actions'] = task
        ? [{ type: ScheduleActions.RunActorTask, actorTaskId: task.id }]
        : [];
    const scheduleFields = {
        ...FIXTURE_SCHEDULE,
        title: 'Eval fixture (read-only)',
        description: 'Permanent fixture for schedule-tool MCP agent evals. Do not delete; do not modify.',
        actions,
    };
    // Reset everything an eval agent may have changed: enabled state, cadence, actions.
    if (schedule) {
        if (!IS_DRY_RUN) await client.schedule(schedule.id).update(scheduleFields);
        console.log(`♻️  ${DRY}Reset fixture schedule "${FIXTURE_SCHEDULE_NAME}" (${schedule.id})`);
    } else {
        const created = IS_DRY_RUN
            ? undefined
            : await client.schedules().create({ ...scheduleFields, name: FIXTURE_SCHEDULE_NAME });
        console.log(`🌱 ${DRY}Created fixture schedule "${FIXTURE_SCHEDULE_NAME}"${created ? ` (${created.id})` : ''}`);
    }

    // Check the content, not the storage: a seed that failed after the create is repaired on the next run.
    if (!(await client.dataset(`~${FIXTURE_DATASET_NAME}`).get())?.itemCount) {
        if (!IS_DRY_RUN) {
            const dataset = await client.datasets().getOrCreate(FIXTURE_DATASET_NAME);
            await client.dataset(dataset.id).pushItems(FIXTURE_DATASET_ITEMS);
        }
        console.log(`🌱 ${DRY}Created fixture dataset "${FIXTURE_DATASET_NAME}"`);
    }
    if (!(await client.keyValueStore(`~${FIXTURE_KEY_VALUE_STORE_NAME}`).recordExists(FIXTURE_RECORD.key))) {
        if (!IS_DRY_RUN) {
            const store = await client.keyValueStores().getOrCreate(FIXTURE_KEY_VALUE_STORE_NAME);
            await client.keyValueStore(store.id).setRecord(FIXTURE_RECORD);
        }
        console.log(`🌱 ${DRY}Created fixture key-value store "${FIXTURE_KEY_VALUE_STORE_NAME}"`);
    }

    console.log(IS_DRY_RUN ? '✅ Dry run complete, nothing changed' : '✅ Fixtures ready');
}

void main();
