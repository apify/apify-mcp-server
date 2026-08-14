import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { respondOk } from '../../utils/mcp.js';
import { actorTaskOutputSchema } from '../structured_output_schemas.js';
import { setTaskPublication, taskResult } from './task_helpers.js';

const publishActorTaskArgs = z.object({
    taskId: z
        .string()
        .min(1)
        .describe(
            'The task to publish: its ID, its name (resolved against your own tasks), or "username/task-name" for a task owned by someone else.',
        ),
});

/**
 * https://docs.apify.com/api/v2/actor-task-put
 */
export const publishActorTask: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_TASK_PUBLISH,
    title: 'Publish Actor task',
    description: `Publish a task on its public landing page.
The task's Actor must be public and the task must have its public display configuration set up -
at least \`publicConfig.inputSchemaFields\` and \`publicConfig.datasetView\`. If publishing fails
because the task is not ready, set those with ${HELPER_TOOLS.ACTOR_TASK_UPDATE} and try again.
At most 50 tasks can be published per Actor.
Publishing an already published task has no effect.
Requires write access to both the task and its Actor.
Use ${HELPER_TOOLS.ACTOR_TASK_UNPUBLISH} to take the page down again.

USAGE:
- Use when the user wants to publish a saved task on its public landing page.

USAGE EXAMPLES:
- user_input: Publish my task my-task
- user_input: Publish task E2jjCZBezvAZnX8Rb`,
    inputSchema: z.toJSONSchema(publishActorTaskArgs) as ToolInputSchema,
    outputSchema: actorTaskOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(publishActorTaskArgs)),
    annotations: {
        title: 'Publish Actor task',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client } = toolArgs;
        const parsed = publishActorTaskArgs.parse(args);
        const task = await setTaskPublication(client, parsed.taskId, true);

        const result = taskResult(task);
        const summary = `Task "${task.name}" (ID: ${task.id}) is published. The link to the public page is available in Apify Console, on the task's Publication tab.`;
        return respondOk([JSON.stringify(result), summary], { structuredContent: result });
    },
} as const);
