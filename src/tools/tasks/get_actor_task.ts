import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { respondOk, respondUserError } from '../../utils/mcp.js';
import { actorTaskOutputSchema } from '../structured_output_schemas.js';
import { taskResult } from './task_helpers.js';

const getActorTaskArgs = z.object({
    taskId: z.string().min(1).describe('The ID or task-name of the task to fetch.'),
});

/**
 * https://docs.apify.com/api/v2/actor-task-get
 */
export const getActorTask: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_TASK_GET,
    title: 'Get Actor task',
    description: `Get a saved Actor task — the Actor it runs, its name, title, description, and run options.
Input values are not returned (they may contain secrets), only the input field names.
Also reports whether the task is published on a public landing page, and its display configuration if so.
Use ${HELPER_TOOLS.ACTOR_TASK_UPDATE} to change the task.

USAGE:
- Use when you need a task's current settings.
- Use to check whether a task is published.

USAGE EXAMPLES:
- user_input: Show me my task my-example-task
- user_input: What Actor does task E2jjCZBezvAZnX8Rb run?
- user_input: Is task E2jjCZBezvAZnX8Rb published?`,
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
        const task = await client.task(parsed.taskId).get();
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
