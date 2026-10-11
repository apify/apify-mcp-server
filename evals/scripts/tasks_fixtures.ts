#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Fixtures for the `merge/tasks/*` items in the `mcp-server-evals-merge` dataset (task-tool MCP agent evals).
 *
 * Deletes the tasks a run left behind (delete rules in `tasks_sweep.ts`) and resets the one
 * permanent read-only fixture task, creating it if missing.
 *
 * Usage: pnpm run evals:mcp-agent:tasks-fixtures [--run-id <id>] [--dry-run]
 */

import 'dotenv/config';

import { ApifyClient } from 'apify-client';

import { findMissingEnvVars, sanitizeProcessEnv } from '../environment.js';
import { parseRunIdArg } from '../run_id.js';
import { FIXTURE_TASK_NAME, isSweepableTask } from './tasks_sweep.js';

sanitizeProcessEnv();

const FIXTURE_ACTOR = 'apify/normal-mode-test-actor';
const FIXTURE_INPUT = { firstNumber: 1, secondNumber: 2 };

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
    if (runId) console.log(`🧹 ${DRY}Tearing down run "${runId}"`);

    // Read every page before deleting anything: offset paging skips entries when the
    // collection shrinks underneath it, and a missed leftover fails the next run.
    const tasks = [];
    for await (const task of client.tasks().list()) tasks.push(task);

    const now = Date.now();
    let fixture;
    for (const task of tasks) {
        if (task.name === FIXTURE_TASK_NAME) {
            fixture = task;
            continue;
        }
        if (!isSweepableTask(task, runId, now)) continue;
        if (!IS_DRY_RUN) await client.task(task.id).delete();
        console.log(`🗑️  ${DRY}Deleted leftover task "${task.name}" (${task.id})`);
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
            description: 'Permanent fixture for task-tool MCP agent evals. Do not modify or delete.',
            input: FIXTURE_INPUT,
        });
        console.log(`🌱 Created fixture task "${task.name}" (${task.id})`);
    }

    console.log(IS_DRY_RUN ? '✅ Dry run complete, nothing changed' : '✅ Task fixtures ready');
}

void main();
