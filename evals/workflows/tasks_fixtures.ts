#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Fixtures for the `tasks-evals` and `tasks-evals-errors` datasets (task-tool workflow evals).
 *
 * Deletes tasks named `eval-*` left behind by previous runs and ensures the one
 * permanent read-only fixture task exists. Run it before every eval run: the create
 * cases never clean up, and task names are unique per account, so the leftovers make
 * the fixed-name cases fail on the next run.
 *
 * Usage: pnpm run evals:workflow:tasks-fixtures [--dry-run]
 */

import 'dotenv/config';

import { ApifyClient } from 'apify-client';

import { findMissingEnvVars } from '../shared/config.js';
import { sanitizeProcessEnv } from './config.js';

sanitizeProcessEnv();

/** Only tasks with this prefix are ever deleted. */
const EVAL_TASK_PREFIX = 'eval-';

/** Permanent read-only fixture, target of pure get-actor-task cases. Never deleted. */
const FIXTURE_TASK_NAME = 'eval-sum-nightly';
const FIXTURE_ACTOR = 'apify/normal-mode-test-actor';
const FIXTURE_INPUT = { firstNumber: 1, secondNumber: 2 };

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

    // Read every page before deleting anything: offset paging skips entries when the
    // collection shrinks underneath it, and a missed leftover fails the next run.
    const tasks = [];
    for await (const task of client.tasks().list()) tasks.push(task);

    let fixture;
    for (const task of tasks) {
        if (task.name === FIXTURE_TASK_NAME) {
            fixture = task;
            continue;
        }
        if (task.name.startsWith(EVAL_TASK_PREFIX)) {
            if (!IS_DRY_RUN) await client.task(task.id).delete();
            console.log(`🗑️  ${DRY}Deleted leftover task "${task.name}" (${task.id})`);
        }
    }

    if (fixture) {
        // Reset the input: an eval agent may have mutated the fixture (e.g. resolving a
        // name collision by updating the existing task).
        if (!IS_DRY_RUN) await client.task(fixture.id).update({ input: FIXTURE_INPUT });
        console.log(`♻️  ${DRY}Reset fixture task "${fixture.name}" (${fixture.id})`);
    } else if (IS_DRY_RUN) {
        console.log(`🌱 ${DRY}Created fixture task "${FIXTURE_TASK_NAME}"`);
    } else {
        const actor = await client.actor(FIXTURE_ACTOR).get();
        if (!actor) throw new Error(`Fixture Actor "${FIXTURE_ACTOR}" not found`);
        const task = await client.tasks().create({
            actId: actor.id,
            name: FIXTURE_TASK_NAME,
            title: 'Eval fixture (read-only)',
            description: 'Permanent fixture for task-tool workflow evals. Do not modify or delete.',
            input: FIXTURE_INPUT,
        });
        console.log(`🌱 Created fixture task "${task.name}" (${task.id})`);
    }

    console.log(IS_DRY_RUN ? '✅ Dry run complete, nothing changed' : '✅ Task fixtures ready');
}

void main();
