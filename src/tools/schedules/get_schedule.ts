import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import type { InternalToolArgs, ToolDescriptionContext, ToolEntry, ToolInputSchema } from '../../types.js';
import { ALL_TOOLS_PRESENT, TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { respondOk, respondUserError } from '../../utils/mcp.js';
import { scheduleOutputSchema } from '../structured_output_schemas.js';
import { buildScheduleResult, formatScheduleState, getScheduleByIdOrName } from './schedule_helpers.js';

const getScheduleArgs = z.object({
    scheduleId: z
        .string()
        .min(1)
        .describe(
            'The schedule to fetch: its ID, its name (resolved against your own schedules), or "username/schedule-name" for a schedule owned by someone else.',
        ),
});

function buildDescription({ hasTool }: ToolDescriptionContext): string {
    return `Get a schedule: when it fires (cron expression and time zone), whether it is enabled, its next and last
run times, and the Actors and tasks it runs with their inputs and run options. Input fields the Actor declares
as secret are returned as encrypted placeholders, never in plaintext.
Requires the schedule's name or ID from the user; no tool lists schedules.
${
    hasTool(HELPER_TOOLS.SCHEDULE_UPDATE)
        ? `Use ${HELPER_TOOLS.SCHEDULE_UPDATE} to change it; its \`actions\` field accepts this result's \`actions\` as they are (a non-JSON Actor input comes back as a string and has to be re-entered as JSON).\n`
        : ''
}
USAGE:
- Use when you need a schedule's current settings or want to know when it runs next.
- Use before changing a schedule's actions, since an update replaces all of them.

USAGE EXAMPLES:
- user_input: Show me my schedule insta-daily
- user_input: When does schedule E2jjCZBezvAZnX8Rb run next?`;
}

/**
 * https://docs.apify.com/api/v2/schedule-get
 */
export const getSchedule: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.SCHEDULE_GET,
    title: 'Get schedule',
    description: buildDescription(ALL_TOOLS_PRESENT),
    buildDescription,
    inputSchema: z.toJSONSchema(getScheduleArgs) as ToolInputSchema,
    outputSchema: scheduleOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(getScheduleArgs)),
    annotations: {
        title: 'Get schedule',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client } = toolArgs;
        const parsed = getScheduleArgs.parse(args);
        const schedule = await getScheduleByIdOrName(client, parsed.scheduleId);
        if (!schedule) {
            return respondUserError(`Schedule ${parsed.scheduleId} was not found.`);
        }

        const result = buildScheduleResult(schedule);
        const summary = `Schedule "${result.name}" (ID: ${result.scheduleId}) has ${formatScheduleState(result)}.`;
        return respondOk([JSON.stringify(result), summary], { structuredContent: result });
    },
} as const);
