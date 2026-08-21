import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import type { InternalToolArgs, ToolDescriptionContext, ToolEntry, ToolInputSchema } from '../../types.js';
import { ALL_TOOLS_PRESENT, TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { respondOk, respondUserError } from '../../utils/mcp.js';
import { actorTaskOutputSchema } from '../structured_output_schemas.js';
import { getTaskByIdOrName, taskResult } from './task_helpers.js';

const getActorTaskArgs = z.object({
    taskId: z
        .string()
        .min(1)
        .describe(
            'The task to fetch: its ID, its name (resolved against your own tasks), or "username/task-name" for a task owned by someone else.',
        ),
});

function buildDescription({ hasTool }: ToolDescriptionContext): string {
    return `Get a saved Actor task: the Actor it runs, its name, title, description, stored input, and run options.
Input fields the Actor declares as secret are returned as encrypted placeholders, never in plaintext.
Also reports whether the task is published on a public landing page, and its display configuration if so.
${hasTool(HELPER_TOOLS.ACTOR_TASK_UPDATE) ? `Use ${HELPER_TOOLS.ACTOR_TASK_UPDATE} to change the task.\n` : ''}
USAGE:
- Use when you need a task's current settings.
- Use to check whether a task is published.

USAGE EXAMPLES:
- user_input: Show me my task my-example-task
- user_input: What Actor does task E2jjCZBezvAZnX8Rb run?
- user_input: Is task E2jjCZBezvAZnX8Rb published?`;
}

/**
 * https://docs.apify.com/api/v2/actor-task-get
 */
export const getActorTask: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_TASK_GET,
    title: 'Get Actor task',
    description: buildDescription(ALL_TOOLS_PRESENT),
    buildDescription,
    inputSchema: z.toJSONSchema(getActorTaskArgs) as ToolInputSchema,
    outputSchema: actorTaskOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(getActorTaskArgs)),
    annotations: {
        title: 'Get Actor task',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client } = toolArgs;
        const parsed = getActorTaskArgs.parse(args);
        const task = await getTaskByIdOrName(client, parsed.taskId);
        if (!task) {
            return respondUserError(`Task ${parsed.taskId} was not found.`);
        }

        const result = taskResult(task);
        const summary = `Task "${result.name}" (ID: ${result.taskId}) runs Actor ${result.actorId}${
            result.publishedAt ? '; published' : ''
        }.`;
        return respondOk([JSON.stringify(result), summary], { structuredContent: result });
    },
} as const);
