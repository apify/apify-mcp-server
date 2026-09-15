import type { ScheduleCreateOrUpdateData } from 'apify-client';
import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import type { InternalToolArgs, ToolDescriptionContext, ToolEntry, ToolInputSchema } from '../../types.js';
import { ALL_TOOLS_PRESENT, TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { respondOk, respondUserError } from '../../utils/mcp.js';
import { scheduleOutputSchema } from '../structured_output_schemas.js';
import {
    buildApiActions,
    buildScheduleResult,
    CRON_EXPRESSION_DESCRIPTION,
    cronExpressionSchema,
    formatRequestedActions,
    formatScheduleState,
    MAX_ACTIONS_PER_TYPE,
    scheduleActionSchema,
    scheduleFieldsSchema,
    type ScheduleTimezone,
} from './schedule_helpers.js';

const createScheduleArgs = z.object({
    ...scheduleFieldsSchema.shape,
    cronExpression: cronExpressionSchema.describe(CRON_EXPRESSION_DESCRIPTION),
    isEnabled: z
        .boolean()
        .default(true)
        .describe(
            'Whether the schedule fires. Defaults to true, so it starts at its next cron time; pass false to create it paused.',
        ),
    actions: z
        .array(scheduleActionSchema)
        .min(1)
        .max(20)
        .describe(
            `What runs at each firing: one entry per Actor or task. At most ${MAX_ACTIONS_PER_TYPE} Actor entries and ${MAX_ACTIONS_PER_TYPE} task entries, counted separately.`,
        ),
});

function buildDescription({ hasTool }: ToolDescriptionContext): string {
    return `Create a schedule that runs Actors and saved Actor tasks automatically on a cron cadence. Each action
runs one Actor (with its own input and run options) or one task (its stored input, optionally with top-level
overrides); Actor and task names are resolved to IDs before the schedule is saved.
The schedule is created enabled unless \`isEnabled: false\` is passed, and fires in \`timezone\` (default UTC).
Up to 10 Actor actions and 10 task actions; while a previous run from an action is still running, the next one
is skipped (\`isExclusive\`, default true).
${
    hasTool(HELPER_TOOLS.ACTOR_CALL)
        ? `A schedule cannot be triggered manually here; to run the Actor or task right now, use ${HELPER_TOOLS.ACTOR_CALL}.\n`
        : ''
}
USAGE:
- Use when the user wants an Actor or task to run repeatedly at set times.
- Turn the user's wording into a 5-field cron expression plus their time zone; use @daily-style shortcuts only when no time is named, because they fire at a random offset within the period.${
        hasTool(HELPER_TOOLS.STORE_SEARCH)
            ? `\n- When the user names the Actor loosely, resolve it with ${HELPER_TOOLS.STORE_SEARCH} instead of guessing an ID.`
            : ''
    }${
        hasTool(HELPER_TOOLS.ACTOR_GET_DETAILS)
            ? `\n- Once you have the exact Actor, read its input schema with ${HELPER_TOOLS.ACTOR_GET_DETAILS} before setting an action's input.`
            : ''
    }${
        hasTool(HELPER_TOOLS.ACTOR_TASK_CREATE)
            ? `\n- To keep the configuration reusable outside the schedule, save it with ${HELPER_TOOLS.ACTOR_TASK_CREATE} first and schedule the task.`
            : ''
    }

USAGE EXAMPLES:
- user_input: Run my task insta-daily every day at 9am Prague time
- user_input: Schedule apify/instagram-scraper every Monday morning with this input`;
}

/**
 * https://docs.apify.com/api/v2/schedules-post
 */
export const createSchedule: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.SCHEDULE_CREATE,
    title: 'Create schedule',
    description: buildDescription(ALL_TOOLS_PRESENT),
    buildDescription,
    inputSchema: z.toJSONSchema(createScheduleArgs) as ToolInputSchema,
    outputSchema: scheduleOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(createScheduleArgs)),
    annotations: {
        title: 'Create schedule',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client } = toolArgs;
        const { actions, cronExpression, timezone, isEnabled, isExclusive, name, title, description } =
            createScheduleArgs.parse(args);

        const built = await buildApiActions(client, actions);
        if ('error' in built) return respondUserError(built.error);

        const schedule = await client.schedules().create({
            cronExpression,
            isEnabled,
            ...(name && { name }),
            ...(title !== undefined && { title }),
            ...(description !== undefined && { description }),
            ...(timezone && { timezone: timezone as ScheduleTimezone }),
            ...(isExclusive !== undefined && { isExclusive }),
            actions: built.actions,
        } satisfies ScheduleCreateOrUpdateData);

        const result = buildScheduleResult(schedule);
        const summary = `Created schedule "${result.name}" (ID: ${result.scheduleId}) running ${formatRequestedActions(
            actions,
        )}: ${formatScheduleState(result)}.`;
        return respondOk([JSON.stringify(result), summary], { structuredContent: result });
    },
} as const);
