import { expect } from 'vitest';

import { ACTOR_NORMAL_MODE, validateStructuredOutputForTool, withClient } from '../helpers.js';
import type { Case, CaseCtx, SuiteClient } from '../types.js';

/**
 * Saved Actor tasks (not MCP Tasks, see `tasks.cases.ts`) against the live API.
 *
 * Names are prefixed `test-task-`, never `eval-`, so the eval harness's `eval-*` sweep on the same
 * account never deletes one mid-assertion.
 *
 * Tool names are hardcoded, not read from `HELPER_TOOLS`, so a rename fails these tests
 * (CONTRIBUTING.md, "Constants and tool names").
 */

/** Unique per call: three transport dimensions register the same case and CI runs PRs concurrently. */
function uniqueTaskName(purpose: string): string {
    return `test-task-${Math.random().toString(36).slice(2, 8)}-${purpose}`;
}

type RunResult = {
    runId: string;
    status: string;
    storages: { datasets?: { default?: { id: string } } };
};

async function createTask(client: SuiteClient, name: string): Promise<string> {
    const result = (await client.callTool({
        name: 'create-actor-task',
        arguments: { actorId: ACTOR_NORMAL_MODE, name, input: { firstNumber: 1, secondNumber: 2 } },
    })) as { structuredContent?: { taskId?: string } };
    expect(result.structuredContent?.taskId).toBeDefined();
    return result.structuredContent!.taskId!;
}

/** The client swallows a 404, so deleting an already-deleted task is fine. */
async function deleteTask(ctx: CaseCtx, taskId?: string): Promise<void> {
    if (!taskId) return;
    await ctx.createApifyClient().task(taskId).delete();
}

/** Runs the task, then reads its dataset through the API as ground truth. */
async function runTaskAndReadItems(
    client: SuiteClient,
    ctx: CaseCtx,
    args: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
    const result = await client.callTool({ name: 'call-actor-task', arguments: { waitSecs: 45, ...args } });
    validateStructuredOutputForTool(result, 'call-actor-task', 'default');
    const run = (result as { structuredContent?: RunResult }).structuredContent;
    expect(run?.status).toBe('SUCCEEDED');
    const datasetId = run?.storages.datasets?.default?.id;
    expect(datasetId).toBeDefined();

    const { items } = await ctx.createApifyClient().dataset(datasetId!).listItems();
    return items;
}

export const actorTasksCases: Case[] = [
    {
        name: 'call-actor-task runs a saved task with its stored input',
        isDeploymentTest: false,
        run: withClient({ tools: ['tasks'] }, async (client, ctx) => {
            let taskId: string | undefined;
            try {
                taskId = await createTask(client, uniqueTaskName('saved'));

                const items = await runTaskAndReadItems(client, ctx, { taskId });

                expect(items[0]).toMatchObject({ firstNumber: 1, secondNumber: 2, sum: 3 });
            } finally {
                await deleteTask(ctx, taskId);
            }
        }),
    },
    {
        name: 'call-actor-task overrides only the input fields given',
        isDeploymentTest: false,
        run: withClient({ tools: ['tasks'] }, async (client, ctx) => {
            const name = uniqueTaskName('override');
            let taskId: string | undefined;
            try {
                taskId = await createTask(client, name);

                // By name, to check the task resolves the same way as in get-actor-task.
                const items = await runTaskAndReadItems(client, ctx, { taskId: name, input: { secondNumber: 5 } });

                expect(items[0]).toMatchObject({ firstNumber: 1, secondNumber: 5, sum: 6 });
            } finally {
                await deleteTask(ctx, taskId);
            }
        }),
    },
];
