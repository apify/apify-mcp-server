import type { ScheduleCreateOrUpdateData } from 'apify-client';
import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import type { InternalToolArgs, ToolDescriptionContext, ToolEntry, ToolInputSchema } from '../../types.js';
import { ALL_TOOLS_PRESENT, TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { respondOk, respondUserError } from '../../utils/mcp.js';
import { scheduleOutputSchema } from '../structured_output_schemas.js';
import { isAmbiguousResourceId, toSafeResourceId } from '../tasks/task_helpers.js';
import {
    buildApiActions,
    buildScheduleResult,
    formatRequestedActions,
    formatScheduleState,
    getScheduleByIdOrName,
    MAX_ACTIONS_PER_TYPE,
    scheduleActionSchema,
    scheduleFieldsSchema,
    type ScheduleTimezone,
} from './schedule_helpers.js';

const updateScheduleArgs = z.object({
    scheduleId: z
        .string()
        .min(1)
        .describe(
            'The schedule to update: its ID, its name (resolved against your own schedules), or "username/schedule-name" for a schedule owned by someone else.',
        ),
    ...scheduleFieldsSchema.shape,
    actions: z
        .array(scheduleActionSchema)
        .min(1)
        .max(20)
        .optional()
        .describe(
            `Replaces ALL stored actions, Actor and task actions alike: send every action to keep, the ones left out are deleted. Omit to leave the actions unchanged. At most ${MAX_ACTIONS_PER_TYPE} Actor entries and ${MAX_ACTIONS_PER_TYPE} task entries, counted separately.`,
        ),
});

function buildDescription({ hasTool }: ToolDescriptionContext): string {
    return `Update a schedule: its cron expression or time zone, enable or disable it, rename it, or replace its actions.
Fields you omit keep their stored value. "Pause", "stop" or "turn off" mean \`isEnabled: false\`; "resume" or
"turn on" mean \`isEnabled: true\` — never delete a schedule to pause it.
\`actions\` replaces all stored actions, Actor and task actions alike: to add or remove one, ${
        hasTool(HELPER_TOOLS.SCHEDULE_GET)
            ? `read the schedule with ${HELPER_TOOLS.SCHEDULE_GET}`
            : 'read the schedule first'
    }, copy its \`actions\`, edit the copy, and send the whole array. Replacing actions restarts exclusivity tracking,
so a run already in progress is not counted.

USAGE:
- Use to change when a schedule fires, to pause or resume it, or to change what it runs.

USAGE EXAMPLES:
- user_input: Pause my schedule insta-daily
- user_input: Change schedule insta-daily to run every 6 hours
- user_input: Add my task weekly-report to schedule insta-daily`;
}

/**
 * https://docs.apify.com/api/v2/schedule-put
 */
export const updateSchedule: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.SCHEDULE_UPDATE,
    title: 'Update schedule',
    description: buildDescription(ALL_TOOLS_PRESENT),
    buildDescription,
    inputSchema: z.toJSONSchema(updateScheduleArgs) as ToolInputSchema,
    outputSchema: scheduleOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(updateScheduleArgs)),
    annotations: {
        title: 'Update schedule',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client } = toolArgs;
        const { scheduleId, actions, name, title, description, cronExpression, timezone, isEnabled, isExclusive } =
            updateScheduleArgs.parse(args);

        // The API merges the fields it receives, so no pre-read is needed to keep the rest — only an
        // ambiguous scheduleId (an ID-shaped name) has to be pinned to the real ID by lookup.
        let resolvedScheduleId = toSafeResourceId(scheduleId);
        if (isAmbiguousResourceId(scheduleId)) {
            const stored = await getScheduleByIdOrName(client, scheduleId);
            if (!stored) return respondUserError(`Schedule ${scheduleId} was not found.`);
            resolvedScheduleId = stored.id;
        }

        const built = actions ? await buildApiActions(client, actions) : undefined;
        if (built && 'error' in built) return respondUserError(built.error);

        const update: ScheduleCreateOrUpdateData = {
            ...(name && { name }),
            ...(title !== undefined && { title }),
            ...(description !== undefined && { description }),
            ...(cronExpression && { cronExpression }),
            // The client's `Timezone` union has no runtime list to validate against; the API validates the name.
            ...(timezone && { timezone: timezone as ScheduleTimezone }),
            ...(isEnabled !== undefined && { isEnabled }),
            ...(isExclusive !== undefined && { isExclusive }),
            ...(built && { actions: built.actions }),
        };

        const schedule = await client.schedule(resolvedScheduleId).update(update);

        const result = buildScheduleResult(schedule);
        const replaced = actions ? `, now running ${formatRequestedActions(actions)}` : '';
        const summary = `Updated schedule "${result.name}" (ID: ${result.scheduleId})${replaced}: ${formatScheduleState(
            result,
        )}.`;
        return respondOk([JSON.stringify(result), summary], { structuredContent: result });
    },
} as const);
