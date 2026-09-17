import { describe, expect, it } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { getCategoryTools } from '../../src/tools/index.js';
import { createSchedule } from '../../src/tools/schedules/create_schedule.js';
import { deleteSchedule } from '../../src/tools/schedules/delete_schedule.js';
import { getSchedule } from '../../src/tools/schedules/get_schedule.js';
import { updateSchedule } from '../../src/tools/schedules/update_schedule.js';
import { scheduleDeleteOutputSchema, scheduleOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { HelperTool, InternalToolArgs, ToolEntry } from '../../src/types.js';
import { mockSchedule, mockScheduleApiClient, type RecordedCall } from './helpers/schedule_client.js';
import {
    expectSchemaConformingStructuredContent,
    expectSoftFailInvalidInput,
    stubToolCallContext,
    type TextToolResult,
    type ToolTelemetrySnapshot,
} from './helpers/tool_context.js';

type StructuredResult = TextToolResult & {
    structuredContent: Record<string, unknown>;
    toolTelemetry?: ToolTelemetrySnapshot;
};

async function run(
    tool: ToolEntry,
    args: Record<string, unknown>,
    client: InternalToolArgs['apifyClient'],
): Promise<StructuredResult> {
    return (await (tool as HelperTool).call(stubToolCallContext(args, client))) as StructuredResult;
}

/** The recorded `actions` of a create or update payload. */
function sentActions(call: RecordedCall): unknown[] {
    return (call.payload as { actions: unknown[] }).actions;
}

describe('get-schedule', () => {
    it('returns the schedule with ISO dates and its actions in the flat tool shape', async () => {
        const { apifyClient, calls } = mockScheduleApiClient(mockSchedule());
        const result = await run(getSchedule, { scheduleId: 'insta-daily' }, apifyClient);

        expect(calls).toEqual([{ fn: 'get', scheduleId: '~insta-daily' }]);
        expectSchemaConformingStructuredContent(result, scheduleOutputSchema);
        // The client parses every `*At` into a Date; the declared schema promises ISO strings.
        expect(result.structuredContent).toMatchObject({
            scheduleId: 'schedule-1',
            name: 'insta-daily',
            cronExpression: '0 9 * * *',
            timezone: 'Europe/Prague',
            isEnabled: true,
            createdAt: '2026-09-01T10:00:00.000Z',
            modifiedAt: '2026-09-02T10:00:00.000Z',
            nextRunAt: '2026-09-12T07:00:00.000Z',
            lastRunAt: '2026-09-11T07:00:00.000Z',
        });
        // API actions come back flat, so this result pastes into update-schedule's `actions`.
        expect(result.structuredContent.actions).toEqual([
            {
                actorId: 'actor-id-1',
                input: { query: 'cats' },
                build: 'latest',
                timeoutSecs: 300,
                memoryMbytes: 1024,
                restartOnError: true,
            },
            { taskId: 'task-1', input: { limit: 5 } },
        ]);
    });

    it('returns a null nextRunAt for a disabled schedule and says so instead of printing null', async () => {
        const { apifyClient } = mockScheduleApiClient(mockSchedule({ isEnabled: false, nextRunAt: null }));
        const result = await run(getSchedule, { scheduleId: 'insta-daily' }, apifyClient);

        expectSchemaConformingStructuredContent(result, scheduleOutputSchema);
        expect(result.structuredContent.nextRunAt).toBeNull();
        expect(result.content[1].text).toContain('disabled');
        expect(result.content[1].text).not.toContain('null');
    });

    it('reports a missing schedule without throwing', async () => {
        const { apifyClient, calls } = mockScheduleApiClient(undefined);
        const result = await run(getSchedule, { scheduleId: 'nope' }, apifyClient);

        expectSoftFailInvalidInput(result);
        expect(result.content[0].text).toContain('not found');
        expect(calls).toEqual([{ fn: 'get', scheduleId: '~nope' }]);
    });

    // The API reads an unqualified scheduleId as an ID, so a bare name must go out as `~name` or
    // the lookup 404s. Anything that already names an owner, or is shaped like an ID, must survive
    // untouched.
    it.each([
        ['a bare name', 'insta-daily', '~insta-daily'],
        ['an already tilde-prefixed name', '~insta-daily', '~insta-daily'],
        ['a username and name', 'janjiran/insta-daily', 'janjiran/insta-daily'],
        ['a username and name in tilde form', 'janjiran~insta-daily', 'janjiran~insta-daily'],
        ['a 17-character ID', 'E2jjCZBezvAZnX8Rb', 'E2jjCZBezvAZnX8Rb'],
    ])('sends %s as "%s"', async (_label, given, expected) => {
        const { apifyClient, calls } = mockScheduleApiClient(mockSchedule());
        await run(getSchedule, { scheduleId: given }, apifyClient);

        expect(calls).toEqual([{ fn: 'get', scheduleId: expected }]);
    });

    it('retries a 17-character value as a name when the ID lookup misses', async () => {
        // A bare 17-alnum value is shape-identical to an ID and to a legal schedule name, so a miss
        // under the ID reading must fall back to the name reading instead of reporting not-found.
        const stored = mockSchedule({ id: 'realscheduleid123', name: 'zzmcpcprobeseven1' });
        const { apifyClient, calls } = mockScheduleApiClient((scheduleId: string) =>
            scheduleId === '~zzmcpcprobeseven1' ? stored : undefined,
        );
        const result = await run(getSchedule, { scheduleId: 'zzmcpcprobeseven1' }, apifyClient);

        expect(calls).toEqual([
            { fn: 'get', scheduleId: 'zzmcpcprobeseven1' },
            { fn: 'get', scheduleId: '~zzmcpcprobeseven1' },
        ]);
        expect(result.structuredContent).toMatchObject({ scheduleId: 'realscheduleid123', name: 'zzmcpcprobeseven1' });
    });
});

describe('create-schedule', () => {
    it('resolves the task name, enables the schedule by default and sends only the given fields', async () => {
        const { apifyClient, calls } = mockScheduleApiClient(mockSchedule());
        const result = await run(
            createSchedule,
            {
                name: 'insta-daily',
                cronExpression: '0 9 * * *',
                timezone: 'Europe/Prague',
                actions: [{ taskId: 'my-task' }],
            },
            apifyClient,
        );

        expect(calls).toEqual([
            // The API looks tasks up by ID only, so a bare task name is resolved first (as `~name`).
            { fn: 'task.get', taskId: '~my-task' },
            {
                fn: 'create',
                payload: {
                    name: 'insta-daily',
                    cronExpression: '0 9 * * *',
                    timezone: 'Europe/Prague',
                    // The API default is false — a schedule created without it never fires.
                    isEnabled: true,
                    actions: [{ type: 'RUN_ACTOR_TASK', actorTaskId: 'task-1' }],
                },
            },
        ]);
        expectSchemaConformingStructuredContent(result, scheduleOutputSchema);
    });

    it('resolves an Actor by full name and sends its input as a JSON body', async () => {
        const { apifyClient, calls } = mockScheduleApiClient(mockSchedule(), {
            actor: (actorId) => (actorId === 'apify/instagram-scraper' ? { id: 'E2jjCZBezvAZnX8Rb' } : undefined),
        });
        await run(
            createSchedule,
            {
                cronExpression: '0 9 * * 1',
                actions: [{ actorId: 'apify/instagram-scraper', input: { query: 'cats' }, memoryMbytes: 2048 }],
            },
            apifyClient,
        );

        expect(calls[0]).toEqual({ fn: 'actor.get', actorId: 'apify/instagram-scraper' });
        expect(sentActions(calls[1])).toEqual([
            {
                type: 'RUN_ACTOR',
                actorId: 'E2jjCZBezvAZnX8Rb',
                runInput: { body: '{"query":"cats"}', contentType: expect.stringMatching(/^application\/json/) },
                runOptions: { memoryMbytes: 2048 },
            },
        ]);
    });

    it('sends a task action input as an object', async () => {
        // apify-client types it as a string, but the API rejects a string and merges the object
        // into the stored task input at run time.
        const { apifyClient, calls } = mockScheduleApiClient(mockSchedule());
        await run(
            createSchedule,
            { cronExpression: '0 9 * * *', actions: [{ taskId: 'my-task', input: { limit: 5 } }] },
            apifyClient,
        );

        expect(sentActions(calls[1])).toEqual([{ type: 'RUN_ACTOR_TASK', actorTaskId: 'task-1', input: { limit: 5 } }]);
    });

    it('creates a paused schedule when isEnabled is false', async () => {
        const { apifyClient, calls } = mockScheduleApiClient(mockSchedule({ isEnabled: false, nextRunAt: null }));
        const result = await run(
            createSchedule,
            { cronExpression: '0 9 * * *', isEnabled: false, actions: [{ taskId: 'my-task' }] },
            apifyClient,
        );

        expect(calls[1].payload).toMatchObject({ isEnabled: false });
        expect(result.content[1].text).toContain('disabled');
        expect(result.content[1].text).not.toContain('null');
    });

    it.each([
        ['Actor', { actorId: 'apify/nope' }, { fn: 'actor.get', actorId: 'apify/nope' }],
        ['task', { taskId: 'nope' }, { fn: 'task.get', taskId: '~nope' }],
    ])('reports a missing %s without creating the schedule', async (_kind, action, lookup) => {
        const { apifyClient, calls } = mockScheduleApiClient(mockSchedule(), {
            actor: () => undefined,
            task: () => undefined,
        });
        const result = await run(createSchedule, { cronExpression: '0 9 * * *', actions: [action] }, apifyClient);

        expectSoftFailInvalidInput(result);
        expect(result.content[0].text).toContain('not found');
        expect(calls).toEqual([lookup]);
    });

    it.each([
        ['both an Actor and a task', { actorId: 'actor-id-1', taskId: 'my-task' }],
        ['neither an Actor nor a task', {}],
    ])('rejects an action naming %s before any API call', async (_label, action) => {
        const { apifyClient, calls } = mockScheduleApiClient(mockSchedule());
        const result = await run(createSchedule, { cronExpression: '0 9 * * *', actions: [action] }, apifyClient);

        expectSoftFailInvalidInput(result);
        expect(calls).toEqual([]);
    });
});

describe('update-schedule', () => {
    it('sends only the provided fields and skips the pre-read for a plain name', async () => {
        const { apifyClient, calls } = mockScheduleApiClient(mockSchedule({ isEnabled: false, nextRunAt: null }));
        const result = await run(updateSchedule, { scheduleId: 'insta-daily', isEnabled: false }, apifyClient);

        // Top-level fields merge server-side, so nothing has to be read before a partial update.
        expect(calls).toEqual([{ fn: 'update', scheduleId: '~insta-daily', payload: { isEnabled: false } }]);
        expectSchemaConformingStructuredContent(result, scheduleOutputSchema);
    });

    it('resolves a 17-character name to its ID before updating', async () => {
        // Without the lookup the update would go out with the name read as an ID and 404 even
        // though the schedule exists.
        const stored = mockSchedule({ id: 'realscheduleid123', name: 'zzmcpcprobeseven1' });
        const { apifyClient, calls } = mockScheduleApiClient((scheduleId: string) =>
            scheduleId === 'zzmcpcprobeseven1' ? undefined : stored,
        );
        await run(updateSchedule, { scheduleId: 'zzmcpcprobeseven1', isEnabled: false }, apifyClient);

        expect(calls).toEqual([
            { fn: 'get', scheduleId: 'zzmcpcprobeseven1' },
            { fn: 'get', scheduleId: '~zzmcpcprobeseven1' },
            { fn: 'update', scheduleId: 'realscheduleid123', payload: { isEnabled: false } },
        ]);
    });

    it('reports a missing schedule from the pre-read without updating', async () => {
        const { apifyClient, calls } = mockScheduleApiClient(() => undefined);
        const result = await run(updateSchedule, { scheduleId: 'zzmcpcprobeseven1', isEnabled: false }, apifyClient);

        expectSoftFailInvalidInput(result);
        expect(result.content[0].text).toContain('not found');
        expect(calls.map(({ fn }) => fn)).toEqual(['get', 'get']);
    });

    it('replaces the stored actions with the given list', async () => {
        const { apifyClient, calls } = mockScheduleApiClient(mockSchedule());
        await run(
            updateSchedule,
            { scheduleId: 'insta-daily', actions: [{ taskId: 'my-task' }, { actorId: 'apify/instagram-scraper' }] },
            apifyClient,
        );

        expect(calls.at(-1)).toEqual({
            fn: 'update',
            scheduleId: '~insta-daily',
            payload: {
                actions: [
                    { type: 'RUN_ACTOR_TASK', actorTaskId: 'task-1' },
                    { type: 'RUN_ACTOR', actorId: 'actor-id-1' },
                ],
            },
        });
    });

    it("accepts a get-schedule result's actions unchanged and rebuilds the stored API actions", async () => {
        // `actions` replaces everything stored, so "add one" is get → append → update. That only
        // works if the flat shape converts back to exactly what the API holds, minus server ids.
        const { apifyClient, calls } = mockScheduleApiClient(mockSchedule());
        const read = await run(getSchedule, { scheduleId: 'insta-daily' }, apifyClient);
        await run(updateSchedule, { scheduleId: 'insta-daily', actions: read.structuredContent.actions }, apifyClient);

        const storedApiActions = mockSchedule().actions.map(({ id: _id, ...action }) => action);
        expect(sentActions(calls[calls.length - 1])).toEqual(storedApiActions);
    });

    // The API caps the two kinds separately, so 11 Actors is over the limit even though the
    // 20-entry total is not, and it rejects only after every name has cost a lookup.
    it.each([
        ['Actors', (i: number) => ({ actorId: `actor-${i}` }), 'at most 10 Actors; 11 were given'],
        ['tasks', (i: number) => ({ taskId: `task-${i}` }), 'at most 10 tasks; 11 were given'],
    ])('rejects more than 10 %s before resolving any name', async (_kind, build, message) => {
        const { apifyClient, calls } = mockScheduleApiClient(mockSchedule());
        const actions = Array.from({ length: 11 }, (_unused, index) => build(index));
        const result = await run(createSchedule, { cronExpression: '0 9 * * *', actions }, apifyClient);

        expect(result.content[0].text).toContain(message);
        expect(calls).toEqual([]);
    });

    it('accepts 10 Actors and 10 tasks together', async () => {
        const { apifyClient, calls } = mockScheduleApiClient(mockSchedule());
        const actions = [
            ...Array.from({ length: 10 }, (_unused, index) => ({ actorId: `actor-${index}` })),
            ...Array.from({ length: 10 }, (_unused, index) => ({ taskId: `task-${index}` })),
        ];
        await run(createSchedule, { cronExpression: '0 9 * * *', actions }, apifyClient);

        expect(sentActions(calls.at(-1)!)).toHaveLength(20);
    });

    it('leaves name validation to the API instead of throwing a ZodError at the client', async () => {
        // The shared AJV instance strips the `pattern` keyword, so a regex here would not gate the
        // call — it would only throw inside the tool body and reach the client as serialised JSON.
        const { apifyClient, calls } = mockScheduleApiClient(mockSchedule());
        await run(
            createSchedule,
            { cronExpression: '0 9 * * *', name: '-bad-', actions: [{ taskId: 'my-task' }] },
            apifyClient,
        );

        expect(calls.at(-1)).toMatchObject({ fn: 'create', payload: { name: '-bad-' } });
    });

    it('rejects an empty actions list before any API call', async () => {
        // `actions: []` is truthy to the API and deletes every stored action.
        const { apifyClient, calls } = mockScheduleApiClient(mockSchedule());
        await expect(run(updateSchedule, { scheduleId: 'insta-daily', actions: [] }, apifyClient)).rejects.toThrow();

        expect(calls).toEqual([]);
    });
});

describe('delete-schedule', () => {
    it('deletes under the real ID and names the removed schedule', async () => {
        const { apifyClient, calls } = mockScheduleApiClient(mockSchedule());
        const result = await run(deleteSchedule, { scheduleId: 'insta-daily' }, apifyClient);

        expect(calls).toEqual([
            { fn: 'get', scheduleId: '~insta-daily' },
            { fn: 'delete', scheduleId: 'schedule-1' },
        ]);
        expectSchemaConformingStructuredContent(result, scheduleDeleteOutputSchema);
        expect(result.structuredContent).toEqual({ scheduleId: 'schedule-1', name: 'insta-daily', deleted: true });
    });

    it('reports a missing schedule without calling delete', async () => {
        // The client swallows a 404 on delete, so without the pre-read a typo would look like success.
        const { apifyClient, calls } = mockScheduleApiClient(undefined);
        const result = await run(deleteSchedule, { scheduleId: 'nope' }, apifyClient);

        expectSoftFailInvalidInput(result);
        expect(result.content[0].text).toContain('not found');
        expect(calls).toEqual([{ fn: 'get', scheduleId: '~nope' }]);
    });

    it('retries a 17-character value as a name before deleting', async () => {
        const stored = mockSchedule({ id: 'realscheduleid123', name: 'zzmcpcprobeseven1' });
        const { apifyClient, calls } = mockScheduleApiClient((scheduleId: string) =>
            scheduleId === '~zzmcpcprobeseven1' ? stored : undefined,
        );
        await run(deleteSchedule, { scheduleId: 'zzmcpcprobeseven1' }, apifyClient);

        expect(calls).toEqual([
            { fn: 'get', scheduleId: 'zzmcpcprobeseven1' },
            { fn: 'get', scheduleId: '~zzmcpcprobeseven1' },
            { fn: 'delete', scheduleId: 'realscheduleid123' },
        ]);
    });
});

// Cross-tool guidance belongs in buildDescription, where hasTool omits tools this session was not
// served. A summary can only gate on `loadedToolNames`, so the schedule tools name no tool at all.
describe('schedule tool results', () => {
    const argsByTool: Record<string, Record<string, unknown>> = {
        [HELPER_TOOLS.SCHEDULE_CREATE]: { cronExpression: '0 9 * * *', actions: [{ taskId: 'my-task' }] },
        [HELPER_TOOLS.SCHEDULE_GET]: { scheduleId: 'insta-daily' },
        [HELPER_TOOLS.SCHEDULE_UPDATE]: { scheduleId: 'insta-daily', isEnabled: false },
        [HELPER_TOOLS.SCHEDULE_DELETE]: { scheduleId: 'insta-daily' },
    };
    // Driven off the registry so a schedule tool added later is covered; it needs an `argsByTool` entry.
    const scheduleTools = getCategoryTools('default').schedules.map((tool) => [tool.name, tool as HelperTool] as const);

    it.each(scheduleTools)('%s names no tool and leaks no internal field', async (name, tool) => {
        expect(argsByTool[name], `add an \`argsByTool\` entry for ${name}`).toBeDefined();
        const { apifyClient } = mockScheduleApiClient(mockSchedule());
        const result = (await tool.call(stubToolCallContext(argsByTool[name], apifyClient))) as TextToolResult;

        for (const toolName of Object.values(HELPER_TOOLS)) {
            expect(result.content[1].text).not.toContain(toolName);
        }
        // `userId` is internal. Input values are returned by contract (secret fields arrive encrypted).
        expect(JSON.stringify(result)).not.toContain('user-secret');
    });
});
