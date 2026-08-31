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
 * Usage:
 *   pnpm run evals:workflow:tasks-fixtures
 *   pnpm run evals:workflow:tasks-fixtures -- --dry-run   # list what it would delete
 */

import 'dotenv/config';

import { ApifyClient } from 'apify-client';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { findMissingEnvVars } from '../shared/config.js';
import { sanitizeProcessEnv } from './config.js';

sanitizeProcessEnv();

/** Only tasks with this prefix are ever deleted. */
const EVAL_TASK_PREFIX = 'eval-';

/** Permanent read-only fixture, target of pure get-actor-task cases. Never deleted. */
const FIXTURE_TASK_NAME = 'eval-sum-nightly';
const FIXTURE_ACTOR = 'apify/normal-mode-test-actor';
const FIXTURE_INPUT = { firstNumber: 1, secondNumber: 2 };

async function main() {
    // pnpm forwards the `--` itself, and yargs reads it as end-of-options and ignores
    // every flag behind it. Drop it so both call styles work.
    const args = hideBin(process.argv).filter((arg) => arg !== '--');
    const argv = (await yargs(args)
        .options({
            'dry-run': {
                type: 'boolean',
                description: 'Print what would be deleted, created, or reset and exit without writing',
                default: false,
            },
        })
        .help().argv) as { dryRun: boolean };

    const missing = findMissingEnvVars(['APIFY_TOKEN']);
    if (missing.length > 0) {
        console.error(`❌ Error: missing environment variable(s): ${missing.join(', ')}`);
        process.exit(1);
    }
    const client = new ApifyClient({ token: process.env.APIFY_TOKEN });

    // This script deletes tasks, so name the account it is about to delete them on before
    // it does: APIFY_TOKEN often points at a personal account rather than the eval one.
    const user = await client.user('me').get();
    console.log(`👤 Account: ${user.username ?? '(unknown)'} (${user.id})${argv.dryRun ? ' — dry run' : ''}`);

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
            if (argv.dryRun) {
                console.log(`🗑️  Would delete leftover task "${task.name}" (${task.id})`);
                continue;
            }
            await client.task(task.id).delete();
            console.log(`🗑️  Deleted leftover task "${task.name}" (${task.id})`);
        }
    }

    if (fixture) {
        // Reset the input: an eval agent may have mutated the fixture (e.g. resolving a
        // name collision by updating the existing task).
        if (argv.dryRun) {
            console.log(`♻️  Would reset fixture task "${fixture.name}" (${fixture.id})`);
        } else {
            await client.task(fixture.id).update({ input: FIXTURE_INPUT });
            console.log(`♻️  Reset fixture task "${fixture.name}" (${fixture.id})`);
        }
    } else if (argv.dryRun) {
        console.log(`🌱 Would create fixture task "${FIXTURE_TASK_NAME}" on ${FIXTURE_ACTOR}`);
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

    console.log(argv.dryRun ? '✅ Dry run complete, nothing changed' : '✅ Task fixtures ready');
}

void main();
