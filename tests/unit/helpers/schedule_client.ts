import { JSON_CONTENT_TYPE } from '../../../src/tools/schedules/schedule_helpers.js';
import type { InternalToolArgs } from '../../../src/types.js';
import { mockApifyClient } from './tool_context.js';

/**
 * A schedule as the client returns it: every `*At` field parsed into a Date (the client's
 * `parseDateFields`), actions in the API's tagged shape, and an internal `userId` the tools must not leak.
 */
export function mockSchedule(overrides: Record<string, unknown> = {}) {
    return {
        id: 'schedule-1',
        userId: 'user-secret',
        name: 'insta-daily',
        title: 'Insta daily',
        description: 'Cats every morning',
        cronExpression: '0 9 * * *',
        timezone: 'Europe/Prague',
        isEnabled: true,
        isExclusive: true,
        createdAt: new Date('2026-09-01T10:00:00.000Z'),
        modifiedAt: new Date('2026-09-02T10:00:00.000Z'),
        nextRunAt: new Date('2026-09-12T07:00:00.000Z'),
        lastRunAt: new Date('2026-09-11T07:00:00.000Z'),
        actions: [
            {
                id: 'action-1',
                type: 'RUN_ACTOR',
                actorId: 'actor-id-1',
                runInput: { body: '{"query":"cats"}', contentType: JSON_CONTENT_TYPE },
                runOptions: { build: 'latest', timeoutSecs: 300, memoryMbytes: 1024, restartOnError: true },
            },
            { id: 'action-2', type: 'RUN_ACTOR_TASK', actorTaskId: 'task-1', input: { limit: 5 } },
        ],
        ...overrides,
    };
}

/** A recorded client call; `actorId` / `taskId` are set on the lookups that resolve action names to IDs. */
export type RecordedCall = { fn: string; scheduleId?: string; actorId?: string; taskId?: string; payload?: unknown };

type Resolver = (id: string) => unknown;

/**
 * Fake ApifyClient covering everything the schedule tools use: `schedule().get/update/delete()`,
 * `schedules().create()`, and the `actor().get()` / `task().get()` lookups that turn action names
 * into IDs. Every call is recorded into `calls`. The function form of `schedule` maps the requested
 * id to the document the API would return, so a test can make the ID reading miss and the `~name`
 * reading hit; the `actor` and `task` resolvers do the same for actions and default to a hit.
 */
export function mockScheduleApiClient(
    schedule: unknown | Resolver,
    {
        actor = () => ({ id: 'actor-id-1' }),
        task = () => ({ id: 'task-1' }),
    }: { actor?: Resolver; task?: Resolver } = {},
): {
    apifyClient: InternalToolArgs['apifyClient'];
    calls: RecordedCall[];
} {
    const calls: RecordedCall[] = [];
    const resolve = (scheduleId: string) => (typeof schedule === 'function' ? schedule(scheduleId) : schedule);
    const apifyClient = mockApifyClient({
        // `scheduleId` is recorded because the tools normalize a bare name to `~name` before the
        // call — the API would otherwise read the name as an ID and 404.
        schedule: (scheduleId: string) => ({
            get: async () => {
                calls.push({ fn: 'get', scheduleId });
                return resolve(scheduleId);
            },
            update: async (payload: unknown) => {
                calls.push({ fn: 'update', scheduleId, payload });
                return resolve(scheduleId);
            },
            delete: async () => {
                calls.push({ fn: 'delete', scheduleId });
            },
        }),
        schedules: () => ({
            create: async (payload: unknown) => {
                calls.push({ fn: 'create', payload });
                return schedule;
            },
        }),
        actor: (actorId: string) => ({
            get: async () => {
                calls.push({ fn: 'actor.get', actorId });
                return actor(actorId);
            },
        }),
        task: (taskId: string) => ({
            get: async () => {
                calls.push({ fn: 'task.get', taskId });
                return task(taskId);
            },
        }),
    });
    return { apifyClient, calls };
}
