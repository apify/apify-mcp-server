#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Fixtures for the `tasks-evals` dataset (task-tool workflow evals).
 *
 * Deletes tasks named `eval-*` left behind by previous runs and ensures the one
 * permanent read-only fixture task exists. Run it before an eval run when a
 * previous run left debris (task names are unique per account, so leftovers make
 * fixed-name cases fail on rerun).
 *
 * Usage: pnpm run evals:workflow:tasks-fixtures
 */

import 'dotenv/config';

import { ApifyClient } from 'apify-client';

import { sanitizeProcessEnv } from '../shared/config.js';

sanitizeProcessEnv();

/** Only tasks with this prefix are ever deleted. */
const EVAL_TASK_PREFIX = 'eval-';

/** Permanent read-only fixture, target of pure get-actor-task cases. Never deleted. */
const FIXTURE_TASK_NAME = 'eval-sum-nightly';
const FIXTURE_ACTOR = 'apify/normal-mode-test-actor';
const FIXTURE_INPUT = { firstNumber: 1, secondNumber: 2 };

async function main() {
    const token = process.env.APIFY_TOKEN;
    if (!token) {
        console.error('❌ Error: missing environment variable APIFY_TOKEN');
        process.exit(1);
    }
    const client = new ApifyClient({ token });

    const { items } = await client.tasks().list({ limit: 1000 });
    let fixture;
    for (const task of items) {
        if (task.name === FIXTURE_TASK_NAME) {
            fixture = task;
            continue;
        }
        if (task.name.startsWith(EVAL_TASK_PREFIX)) {
            await client.task(task.id).delete();
            console.log(`🗑️  Deleted leftover task "${task.name}" (${task.id})`);
        }
    }

    if (fixture) {
        // Reset the input: an eval agent may have mutated the fixture (e.g. resolving a
        // name collision by updating the existing task).
        await client.task(fixture.id).update({ input: FIXTURE_INPUT });
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

    console.log('✅ Task fixtures ready');
}

void main();
