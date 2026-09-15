import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import type { InternalToolArgs, ToolDescriptionContext, ToolEntry, ToolInputSchema } from '../../types.js';
import { ALL_TOOLS_PRESENT, TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { respondOk, respondUserError } from '../../utils/mcp.js';
import { scheduleDeleteOutputSchema } from '../structured_output_schemas.js';
import { getScheduleByIdOrName } from './schedule_helpers.js';

const deleteScheduleArgs = z.object({
    scheduleId: z
        .string()
        .min(1)
        .describe(
            'The schedule to delete: its ID, its name (resolved against your own schedules), or "username/schedule-name" for a schedule owned by someone else.',
        ),
});

function buildDescription({ hasTool }: ToolDescriptionContext): string {
    return `Delete a schedule permanently. Its future runs stop; runs that already started are not affected, and the
Actors and tasks it referenced are kept. To stop a schedule temporarily, disable it instead${
        hasTool(HELPER_TOOLS.SCHEDULE_UPDATE) ? ` with ${HELPER_TOOLS.SCHEDULE_UPDATE}` : ''
    }.

USAGE:
- Use only when the user explicitly wants the schedule removed.

USAGE EXAMPLES:
- user_input: Delete my schedule insta-daily
- user_input: Remove schedule E2jjCZBezvAZnX8Rb`;
}

/**
 * https://docs.apify.com/api/v2/schedule-delete
 */
export const deleteSchedule: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.SCHEDULE_DELETE,
    title: 'Delete schedule',
    description: buildDescription(ALL_TOOLS_PRESENT),
    buildDescription,
    inputSchema: z.toJSONSchema(deleteScheduleArgs) as ToolInputSchema,
    outputSchema: scheduleDeleteOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(deleteScheduleArgs)),
    annotations: {
        title: 'Delete schedule',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client } = toolArgs;
        const parsed = deleteScheduleArgs.parse(args);
        // The client swallows a 404 on delete, so read first to report a missing schedule and to
        // name the one that was removed.
        const schedule = await getScheduleByIdOrName(client, parsed.scheduleId);
        if (!schedule) {
            return respondUserError(`Schedule ${parsed.scheduleId} was not found.`);
        }
        await client.schedule(schedule.id).delete();

        const result = { scheduleId: schedule.id, name: schedule.name, deleted: true };
        const summary = `Deleted schedule "${schedule.name}" (ID: ${schedule.id}).`;
        return respondOk([JSON.stringify(result), summary], { structuredContent: result });
    },
} as const);
