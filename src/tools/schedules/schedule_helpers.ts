import {
    type Schedule,
    type ScheduleAction,
    ScheduleActions,
    type ScheduleCreateOrUpdateData,
    type ScheduledActorRunInput,
    type ScheduledActorRunOptions,
} from 'apify-client';
import { z } from 'zod';

import type { ApifyClient } from '../../apify_client.js';
import { toIsoString } from '../actors/actor_run_response.js';
import { getResourceByIdOrName, getTaskByIdOrName } from '../tasks/task_helpers.js';

/** A schedule action as the API accepts it on create and update (the server-assigned `id` is optional). */
type ApiScheduleAction = NonNullable<ScheduleCreateOrUpdateData['actions']>[number];

/** apify-client does not export its `Timezone` union, so derive it from the `Schedule` type. */
export type ScheduleTimezone = Schedule['timezone'];

export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/**
 * The API caps Actor actions and task actions separately, not as one total
 * (`MAX_ACTORS_PER_SCHEDULER` / `MAX_TASKS_PER_SCHEDULER`), and answers an over-limit list with
 * `too-many-values` (403). Checked here because a schedule is only rejected after every action's
 * Actor or task name has been resolved, one API call each.
 */
export const MAX_ACTIONS_PER_TYPE = 10;

export const CRON_EXPRESSION_DESCRIPTION =
    'When the schedule fires, as a standard 5-field cron expression "minute hour day-of-month month day-of-week" ' +
    'evaluated in `timezone`. Examples: "0 9 * * *" daily at 09:00, "0 */6 * * *" every 6 hours, "0 9 * * 1" ' +
    'Mondays at 09:00, "0 0 1 * *" on the 1st of each month. The shortcuts @hourly, @daily, @weekly, @monthly ' +
    'and @yearly fire at a random offset inside their period (@daily somewhere between 00:05 and 06:00), so use ' +
    'them only when the user names no time. An optional leading seconds field is accepted; the minimum interval ' +
    'between runs is 10 seconds.';

export const cronExpressionSchema = z.string().min(1).max(100);

/**
 * Only the length caps the API enforces. No `pattern`: the shared AJV instance removes that keyword
 * as a ReDoS mitigation (`utils/ajv.ts`), so a regex here never gates the call — it only fires in the
 * tool body's `parse()`, which throws a raw ZodError that reaches the client as serialised JSON with
 * the pattern in it. The API rejects the same name with a far better message, and the field's
 * `.describe()` text states the rule for the model.
 */
const scheduleNameSchema = z.string().min(3).max(63);

/**
 * One flat action shape for Actor and task actions alike. `buildApiActions` turns it into the API's
 * tagged `RUN_ACTOR` / `RUN_ACTOR_TASK` shape and `fromApiAction` turns it back, so a schedule read
 * pastes into an update unchanged.
 *
 * Deliberately not a z.union: zod renders a union as `anyOf` branches with `additionalProperties:
 * false`, and the shared AJV instance strips unknown properties (`removeAdditional` in utils/ajv.ts),
 * so validating `{ taskId }` against the actorId branch would drop `taskId` before the taskId branch
 * is tried. "Exactly one of actorId / taskId" is therefore checked in `buildApiActions`.
 */
export const scheduleActionSchema = z.object({
    actorId: z
        .string()
        .min(1)
        .optional()
        .describe(
            'Actor to run: its ID, its name (resolved against your own Actors), or "username/actor-name". Give either actorId or taskId, never both.',
        ),
    taskId: z
        .string()
        .min(1)
        .optional()
        .describe('Task to run: its ID, its name (resolved against your own tasks), or "username/task-name".'),
    input: z
        .looseObject({})
        .optional()
        .describe(
            'For an Actor: the input JSON it runs with. For a task: top-level keys that override the stored task input for this run (shallow merge; a nested object replaces the stored one).',
        ),
    build: z.string().optional().describe('Actor actions only: build tag or number to run, e.g. "latest".'),
    timeoutSecs: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Actor actions only: run timeout in seconds; 0 means no timeout.'),
    memoryMbytes: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Actor actions only: memory limit for the run in megabytes.'),
    restartOnError: z.boolean().optional().describe('Actor actions only: restart the run when it fails.'),
});
export type ScheduleActionInput = z.infer<typeof scheduleActionSchema>;

/** Every schedule field the tools write, all optional; the create tool tightens `cronExpression` and `isEnabled`. */
export const scheduleFieldsSchema = z.object({
    name: scheduleNameSchema
        .optional()
        .describe(
            'Name of the schedule, unique within the account: 3-63 characters, letters, digits and dashes only (e.g. "insta-daily"). Generated when omitted.',
        ),
    title: z
        .string()
        .max(40)
        .optional()
        .describe('Human-readable title, at most 40 characters. Generated from the name when omitted.'),
    description: z.string().max(5000).optional().describe('What the schedule is for.'),
    cronExpression: cronExpressionSchema.optional().describe(CRON_EXPRESSION_DESCRIPTION),
    timezone: z
        .string()
        .min(1)
        .optional()
        .describe(
            'IANA time zone the cron expression is evaluated in, e.g. "Europe/Prague", "America/New_York", "Asia/Tokyo". Default "UTC". Take it from the user\'s wording ("9am Prague time").',
        ),
    isEnabled: z
        .boolean()
        .optional()
        .describe('Whether the schedule fires. false pauses it without losing its configuration.'),
    isExclusive: z
        .boolean()
        .optional()
        .describe('If true (the default), an action is skipped while its previous scheduled run is still running.'),
});

/** Fetches a schedule by ID, name, or `username/name`. */
export async function getScheduleByIdOrName(client: ApifyClient, idOrName: string): Promise<Schedule | undefined> {
    return getResourceByIdOrName(idOrName, async (safeId) => client.schedule(safeId).get());
}

/**
 * Resolves the Actor an action runs to its ID, which is all the schedule API accepts.
 *
 * Deliberately NOT `getActorDefinitionCached`: a bare name is caller-relative (`~name` means "my own
 * Actor called name"), while `actorDefinitionCache` is process-wide and serves any cached public
 * Actor to any caller. Keying it by `~name` let one tenant's public Actor answer another tenant's
 * bare name — scheduling the wrong Actor, or succeeding where the answer is not-found. Every other
 * caller of that cache passes an absolute key (an ID or `username/name`), so the fix is to keep
 * caller-relative names out of it rather than to weaken the cache.
 *
 * That lookup is also the wrong shape for scheduling: it fetches the Actor's default build, and a
 * never-built Actor schedules fine but has no build, so `defaultBuild()` raises `unknown-build-tag`
 * (403). `getActorDefinition` maps only 404/400 to null, so that error surfaces to the user as a
 * failed create. `actor(id).get()` resolves the ID without touching a build. Covered by
 * `tests/unit/tools.schedule_actor_resolution.test.ts`.
 */
async function resolveActorId(client: ApifyClient, idOrName: string): Promise<string | undefined> {
    const actor = await getResourceByIdOrName(idOrName, async (safeId) => client.actor(safeId).get());
    return actor?.id;
}

/**
 * Converts the flat tool actions to the API shape. Actor and task references are resolved to IDs
 * here because the API looks both up by ID only and would answer `schedule-actor-not-found` for a
 * name. The first problem is returned as `{ error }` so the tool can answer before any write.
 */
export async function buildApiActions(
    client: ApifyClient,
    actions: ScheduleActionInput[],
): Promise<{ actions: ApiScheduleAction[] } | { error: string }> {
    // Counted before resolving anything: an over-limit list costs one lookup per action otherwise.
    // Actions naming both kinds or neither are counted in neither and reported by the loop below.
    const taskActionCount = actions.filter((action) => action.taskId !== undefined).length;
    const actorActionCount = actions.filter(
        (action) => action.taskId === undefined && action.actorId !== undefined,
    ).length;
    if (actorActionCount > MAX_ACTIONS_PER_TYPE) {
        return { error: `A schedule runs at most ${MAX_ACTIONS_PER_TYPE} Actors; ${actorActionCount} were given.` };
    }
    if (taskActionCount > MAX_ACTIONS_PER_TYPE) {
        return { error: `A schedule runs at most ${MAX_ACTIONS_PER_TYPE} tasks; ${taskActionCount} were given.` };
    }

    const apiActions: ApiScheduleAction[] = [];
    for (const [
        index,
        { actorId, taskId, input, build, timeoutSecs, memoryMbytes, restartOnError },
    ] of actions.entries()) {
        if (taskId !== undefined) {
            if (actorId !== undefined) {
                return { error: `Action ${index + 1} names both an Actor and a task; give either actorId or taskId.` };
            }
            const task = await getTaskByIdOrName(client, taskId);
            if (!task) return { error: `Task ${taskId} was not found.` };
            apiActions.push({
                type: ScheduleActions.RunActorTask,
                actorTaskId: task.id,
                // apify-client types `input` as a string, but the API rejects a string and requires an object.
                ...(input && { input: input as unknown as string }),
            });
            continue;
        }
        if (actorId === undefined) {
            return { error: `Action ${index + 1} names nothing to run; give actorId or taskId.` };
        }
        const resolvedActorId = await resolveActorId(client, actorId);
        if (!resolvedActorId) return { error: `Actor ${actorId} was not found.` };
        const runOptions = {
            ...(build !== undefined && { build }),
            ...(timeoutSecs !== undefined && { timeoutSecs }),
            ...(memoryMbytes !== undefined && { memoryMbytes }),
            ...(restartOnError !== undefined && { restartOnError }),
        };
        apiActions.push({
            type: ScheduleActions.RunActor,
            actorId: resolvedActorId,
            ...(input && { runInput: { body: JSON.stringify(input), contentType: JSON_CONTENT_TYPE } }),
            // apify-client types every run option as required; the API accepts any subset.
            ...(Object.keys(runOptions).length > 0 && { runOptions: runOptions as ScheduledActorRunOptions }),
        });
    }
    return { actions: apiActions };
}

/** One action as the tools return it; `input` keeps the raw body when an Actor input is not JSON. */
type ScheduleActionResult = Omit<ScheduleActionInput, 'input'> & { input?: unknown };

/** A JSON body comes back as the object the tool sent; anything else stays a string. */
function parseRunInputBody({ body, contentType }: ScheduledActorRunInput): unknown {
    if (!contentType?.startsWith('application/json')) return body;
    try {
        return JSON.parse(body);
    } catch {
        return body;
    }
}

/** Inverse of `buildApiActions`: the API's tagged action as the flat shape the tools accept. */
function fromApiAction(action: ScheduleAction): ScheduleActionResult {
    if (action.type === ScheduleActions.RunActorTask) {
        // The API returns the stored task input parsed, despite the client's `string` type.
        return {
            taskId: action.actorTaskId,
            ...(action.input !== undefined && action.input !== null && { input: action.input as unknown }),
        };
    }
    const { runInput, runOptions } = action;
    return {
        actorId: action.actorId,
        ...(runInput?.body !== undefined && { input: parseRunInputBody(runInput) }),
        ...(runOptions?.build !== undefined && { build: runOptions.build }),
        ...(runOptions?.timeoutSecs !== undefined && { timeoutSecs: runOptions.timeoutSecs }),
        ...(runOptions?.memoryMbytes !== undefined && { memoryMbytes: runOptions.memoryMbytes }),
        ...(runOptions?.restartOnError !== undefined && { restartOnError: runOptions.restartOnError }),
    };
}

/** The schedule subset returned by the create, get and update tools. */
export function buildScheduleResult(schedule: Schedule) {
    return {
        scheduleId: schedule.id,
        name: schedule.name,
        title: schedule.title ?? null,
        description: schedule.description ?? null,
        cronExpression: schedule.cronExpression,
        timezone: schedule.timezone,
        isEnabled: schedule.isEnabled,
        isExclusive: schedule.isExclusive,
        // The client turns every `*At` field into a Date although its types promise strings, and the
        // declared output schema promises ISO strings. nextRunAt is null while the schedule is disabled.
        nextRunAt: toIsoString(schedule.nextRunAt) ?? null,
        lastRunAt: toIsoString(schedule.lastRunAt) ?? null,
        createdAt: toIsoString(schedule.createdAt) ?? null,
        modifiedAt: toIsoString(schedule.modifiedAt) ?? null,
        actions: (schedule.actions ?? []).map(fromApiAction),
    };
}
type ScheduleResult = ReturnType<typeof buildScheduleResult>;

/** Cadence and state for a summary; a disabled schedule has no next run, so it never prints "null". */
export function formatScheduleState({
    actions,
    cronExpression,
    timezone,
    isEnabled,
    nextRunAt,
}: ScheduleResult): string {
    const count = `${actions.length} action${actions.length === 1 ? '' : 's'}`;
    const state = isEnabled
        ? `enabled, next run at ${nextRunAt ?? 'unknown'}`
        : 'disabled — it will not run until enabled';
    return `${count} on "${cronExpression}" (${timezone}); ${state}`;
}

/** The Actor and task references exactly as the caller gave them, for the create and update summaries. */
export function formatRequestedActions(actions: ScheduleActionInput[]): string {
    return actions
        .map(({ actorId, taskId }) => (taskId !== undefined ? `task ${taskId}` : `Actor ${actorId}`))
        .join(', ');
}
