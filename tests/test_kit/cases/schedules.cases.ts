import { expect } from 'vitest';

import {
    ACTOR_EXAMPLE_MCP_SERVER,
    ACTOR_NORMAL_MODE,
    validateStructuredOutputForTool,
    withClient,
} from '../helpers.js';
import type { Case, CaseCtx } from '../types.js';

/**
 * Schedule CRUD against the live API: the deterministic platform facts the schedule evals used to
 * assert through an LLM judge (an update replaces the action list, what a name collision returns).
 *
 * Names are prefixed `test-sched-`, never `eval-`: the eval harness sweeps `eval-*` schedules on the
 * same account, so an `eval-`-prefixed name here would be deleted mid-assertion by a concurrent run.
 *
 * Tool names are hardcoded, not read from `HELPER_TOOLS`, so a rename fails these tests
 * (CONTRIBUTING.md, "Integration tests").
 */

/** Unique per call: three transport dimensions register the same case and CI runs PRs concurrently. */
function uniqueScheduleName(purpose: string): string {
    return `test-sched-${Math.random().toString(36).slice(2, 8)}-${purpose}`;
}

const CRON_DAILY_3AM = '0 3 * * *';

/** Always disabled: an orphan left by a crashed run would otherwise keep starting runs on the account. */
function buildCreateArgs(name: string, overrides: Record<string, unknown> = {}) {
    return {
        name,
        cronExpression: CRON_DAILY_3AM,
        isEnabled: false,
        actions: [{ actorId: ACTOR_NORMAL_MODE }],
        ...overrides,
    };
}

/** The subset of `buildScheduleResult` these cases read. */
type ScheduleResult = {
    scheduleId: string;
    name: string;
    cronExpression: string;
    timezone: string;
    isEnabled: boolean;
    isExclusive: boolean;
    nextRunAt: string | null;
    createdAt: string | null;
    actions: { actorId?: string; taskId?: string }[];
};

function expectScheduleResult(result: unknown): ScheduleResult {
    const { structuredContent } = result as { structuredContent?: ScheduleResult };
    expect(structuredContent).toBeDefined();
    return structuredContent as ScheduleResult;
}

function resultText(result: unknown): string {
    return ((result as { content?: { text?: string }[] }).content ?? []).map((part) => part.text ?? '').join('\n');
}

/** Cleanup for a case's own schedule. The client swallows a 404, so an already-deleted one is fine. */
async function deleteSchedule(ctx: CaseCtx, scheduleId?: string): Promise<void> {
    if (!scheduleId) return;
    await ctx.createApifyClient().schedule(scheduleId).delete();
}

/** Schedule create/get/update/delete against the live API. */
export const schedulesCases: Case[] = [
    {
        name: 'create-schedule returns the stored schedule with its cron settings and resolved action',
        isDeploymentTest: false,
        run: withClient({ tools: ['schedules'] }, async (client, ctx) => {
            const name = uniqueScheduleName('create');
            let scheduleId: string | undefined;
            try {
                const result = await client.callTool({
                    name: 'create-schedule',
                    arguments: buildCreateArgs(name, { title: 'Integration test', description: 'Created by a test' }),
                });

                const schedule = expectScheduleResult(result);
                scheduleId = schedule.scheduleId;
                expect(schedule.name).toBe(name);
                expect(schedule.cronExpression).toBe(CRON_DAILY_3AM);
                expect(schedule.timezone).toBe('UTC');
                expect(schedule.isEnabled).toBe(false);
                // Disabled schedules have no next run; createdAt is the sweep's age source.
                expect(schedule.nextRunAt).toBeNull();
                expect(schedule.createdAt).not.toBeNull();
                expect(schedule.actions).toHaveLength(1);
                expect(typeof schedule.actions[0].actorId).toBe('string');
                validateStructuredOutputForTool(result, 'create-schedule', 'default');

                // content[0] is the JSON result, content[1] the summary.
                expect((result as { content?: unknown[] }).content).toHaveLength(2);
                expect(resultText(result)).toContain(name);
            } finally {
                await deleteSchedule(ctx, scheduleId);
            }
        }),
    },
    {
        name: 'get-schedule returns the same schedule by name and by id',
        isDeploymentTest: false,
        run: withClient({ tools: ['schedules'] }, async (client, ctx) => {
            const name = uniqueScheduleName('get');
            let scheduleId: string | undefined;
            try {
                const created = expectScheduleResult(
                    await client.callTool({ name: 'create-schedule', arguments: buildCreateArgs(name) }),
                );
                scheduleId = created.scheduleId;

                const byName = expectScheduleResult(
                    await client.callTool({ name: 'get-schedule', arguments: { scheduleId: name } }),
                );
                const byId = expectScheduleResult(
                    await client.callTool({
                        name: 'get-schedule',
                        arguments: { scheduleId: created.scheduleId },
                    }),
                );

                expect(byName.scheduleId).toBe(created.scheduleId);
                expect(byId.scheduleId).toBe(created.scheduleId);
                expect(byName.name).toBe(name);
                expect(byId.name).toBe(name);
            } finally {
                await deleteSchedule(ctx, scheduleId);
            }
        }),
    },
    {
        name: 'update-schedule replaces the action list instead of appending to it',
        isDeploymentTest: false,
        run: withClient({ tools: ['schedules'] }, async (client, ctx) => {
            const name = uniqueScheduleName('update');
            let scheduleId: string | undefined;
            try {
                const created = expectScheduleResult(
                    await client.callTool({ name: 'create-schedule', arguments: buildCreateArgs(name) }),
                );
                scheduleId = created.scheduleId;

                const updated = expectScheduleResult(
                    await client.callTool({
                        name: 'update-schedule',
                        arguments: { scheduleId: name, actions: [{ actorId: ACTOR_EXAMPLE_MCP_SERVER }] },
                    }),
                );

                expect(updated.actions).toHaveLength(1);
                expect(updated.actions[0].actorId).not.toBe(created.actions[0].actorId);

                // Read back: the replacement is what the API stored, not just what the update echoed.
                const stored = expectScheduleResult(
                    await client.callTool({ name: 'get-schedule', arguments: { scheduleId: name } }),
                );
                expect(stored.actions).toHaveLength(1);
                expect(stored.actions[0].actorId).toBe(updated.actions[0].actorId);
            } finally {
                await deleteSchedule(ctx, scheduleId);
            }
        }),
    },
    {
        name: 'delete-schedule removes the schedule and a later get reports it missing',
        isDeploymentTest: false,
        run: withClient({ tools: ['schedules'] }, async (client, ctx) => {
            const name = uniqueScheduleName('delete');
            let scheduleId: string | undefined;
            try {
                const created = expectScheduleResult(
                    await client.callTool({ name: 'create-schedule', arguments: buildCreateArgs(name) }),
                );
                scheduleId = created.scheduleId;

                const deleted = await client.callTool({
                    name: 'delete-schedule',
                    arguments: { scheduleId: name },
                });
                expect((deleted as { structuredContent?: { deleted?: boolean } }).structuredContent?.deleted).toBe(
                    true,
                );

                const afterDelete = await client.callTool({
                    name: 'get-schedule',
                    arguments: { scheduleId: name },
                });
                expect((afterDelete as { isError?: boolean }).isError).toBe(true);
                expect(resultText(afterDelete)).toContain(`Schedule ${name} was not found.`);
            } finally {
                await deleteSchedule(ctx, scheduleId);
            }
        }),
    },
    {
        name: 'create-schedule reports a name already taken as an error naming that schedule',
        isDeploymentTest: false,
        run: withClient({ tools: ['schedules'] }, async (client, ctx) => {
            const name = uniqueScheduleName('collision');
            let scheduleId: string | undefined;
            try {
                const created = expectScheduleResult(
                    await client.callTool({ name: 'create-schedule', arguments: buildCreateArgs(name) }),
                );
                scheduleId = created.scheduleId;

                // The tool does not catch duplicate names, so this is the API's own error. Probed
                // 2026-09-21: `Some other schedule already has this name ("<name>").`, type
                // `schedule-name-not-unique`, HTTP 409. Only the stable part is asserted: the exact
                // wording is the API's to change.
                const collision = await client.callTool({
                    name: 'create-schedule',
                    arguments: buildCreateArgs(name),
                });
                expect((collision as { isError?: boolean }).isError).toBe(true);
                expect(resultText(collision)).toContain(name);
            } finally {
                await deleteSchedule(ctx, scheduleId);
            }
        }),
    },
    {
        name: 'get-schedule reports an unknown schedule as not found',
        isDeploymentTest: false,
        run: withClient({ tools: ['schedules'] }, async (client) => {
            const name = uniqueScheduleName('missing');

            const result = await client.callTool({ name: 'get-schedule', arguments: { scheduleId: name } });

            expect((result as { isError?: boolean }).isError).toBe(true);
            expect(resultText(result)).toContain(`Schedule ${name} was not found.`);
        }),
    },
    {
        name: 'update-schedule reports an unknown schedule as not found',
        isDeploymentTest: false,
        run: withClient({ tools: ['schedules'] }, async (client) => {
            const name = uniqueScheduleName('missing');

            const result = await client.callTool({
                name: 'update-schedule',
                arguments: { scheduleId: name, isEnabled: false },
            });

            // A plain name skips the tool's pre-read, so this is the API's own 404. Probed
            // 2026-09-21: `Record was not found`, type `record-not-found`. Only the stable part is
            // asserted: the exact wording is the API's to change.
            expect((result as { isError?: boolean }).isError).toBe(true);
            expect(resultText(result)).toMatch(/not found/i);
        }),
    },
    {
        name: 'delete-schedule reports an unknown schedule as not found',
        isDeploymentTest: false,
        run: withClient({ tools: ['schedules'] }, async (client) => {
            const name = uniqueScheduleName('missing');

            const result = await client.callTool({ name: 'delete-schedule', arguments: { scheduleId: name } });

            expect((result as { isError?: boolean }).isError).toBe(true);
            expect(resultText(result)).toContain(`Schedule ${name} was not found.`);
        }),
    },
    {
        name: 'create-schedule round-trips a non-UTC timezone',
        isDeploymentTest: false,
        run: withClient({ tools: ['schedules'] }, async (client, ctx) => {
            const name = uniqueScheduleName('timezone');
            let scheduleId: string | undefined;
            try {
                const created = expectScheduleResult(
                    await client.callTool({
                        name: 'create-schedule',
                        arguments: buildCreateArgs(name, { timezone: 'Europe/Prague' }),
                    }),
                );
                scheduleId = created.scheduleId;
                expect(created.timezone).toBe('Europe/Prague');

                const stored = expectScheduleResult(
                    await client.callTool({ name: 'get-schedule', arguments: { scheduleId: name } }),
                );
                expect(stored.timezone).toBe('Europe/Prague');
            } finally {
                await deleteSchedule(ctx, scheduleId);
            }
        }),
    },
];
