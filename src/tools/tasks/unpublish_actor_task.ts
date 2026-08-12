import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { respondOk } from '../../utils/mcp.js';
import { actorTaskOutputSchema } from '../structured_output_schemas.js';
import { setTaskPublication, taskResult } from './task_helpers.js';

const unpublishActorTaskArgs = z.object({
    taskId: z.string().min(1).describe('The ID or username~task-name of the task to unpublish.'),
});

/**
 * https://docs.apify.com/api/v2/actor-task-put
 */
export const unpublishActorTask: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_TASK_UNPUBLISH,
    title: 'Unpublish Actor task',
    description: `Unpublish a task from its public landing page.
The public display configuration is preserved, so the task can be published again later
with ${HELPER_TOOLS.ACTOR_TASK_PUBLISH}. Unpublishing a task that is not published does nothing.
Requires write access to both the task and its Actor.

USAGE:
- Use when the user wants to take down a task's public landing page.

USAGE EXAMPLES:
- user_input: Unpublish my task my-task
- user_input: Unpublish task E2jjCZBezvAZnX8Rb`,
    inputSchema: z.toJSONSchema(unpublishActorTaskArgs) as ToolInputSchema,
    outputSchema: actorTaskOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(unpublishActorTaskArgs)),
    annotations: {
        title: 'Unpublish Actor task',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client } = toolArgs;
        const parsed = unpublishActorTaskArgs.parse(args);
        const task = await setTaskPublication(client, parsed.taskId, false);

        const result = taskResult(task);
        const summary = `Task "${task.name}" (ID: ${task.id}) is no longer published.`;
        return respondOk([JSON.stringify(result), summary], { structuredContent: result });
    },
} as const);
