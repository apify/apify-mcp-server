import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import type { InternalToolArgs, ToolDescriptionContext, ToolEntry, ToolInputSchema } from '../../types.js';
import { ALL_TOOLS_PRESENT, TOOL_TYPE } from '../../types.js';
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

function buildDescription({ hasTool }: ToolDescriptionContext): string {
    return `Publish a saved task as a public landing page for a specific Actor use case.
The page shows what the task does, selected input values, and the expected output. Published tasks appear
in the Actor's Examples tab and can be discovered by users, search engines, and AI agents. This can help
users understand and try the Actor and can increase its runs. Publish only tasks that represent a useful,
reliable, and specific use case. Not every saved task needs to be public.

The task's Actor must be public and the task must have its public display configuration set up:
at least \`publicConfig.inputSchemaFields\`, \`publicConfig.datasetView\`, and \`publicConfig.seoDescription\`. \
If publishing fails, follow the API reason${hasTool(HELPER_TOOLS.ACTOR_TASK_UPDATE) ? `; update these fields with ${HELPER_TOOLS.ACTOR_TASK_UPDATE} only when the reason identifies them` : ''}.
At most 50 tasks can be published per Actor.
Publishing an already published task has no effect.
Requires write access to both the task and its Actor.
${hasTool(HELPER_TOOLS.ACTOR_TASK_UNPUBLISH) ? `Use ${HELPER_TOOLS.ACTOR_TASK_UNPUBLISH} to take the page down again.\n` : ''}
USAGE:
- Use when the user wants to publish a saved task on its public landing page.

USAGE EXAMPLES:
- user_input: Publish my task my-task
- user_input: Publish task E2jjCZBezvAZnX8Rb`;
}

/**
 * https://docs.apify.com/api/v2/actor-task-put
 */
export const publishActorTask: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_TASK_PUBLISH,
    title: 'Publish Actor task',
    description: buildDescription(ALL_TOOLS_PRESENT),
    buildDescription,
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
        // publishedAt is the server's confirmation that the page is live: without saying so, an agent
        // asked to "confirm it is live" either claims it unverified or makes a redundant lookup.
        const summary =
            `Task "${task.name}" (ID: ${task.id}) is published; publishedAt in the result is the ` +
            `confirmed publication time. ` +
            `The link to the public page is available in Apify Console, on the task's Publication tab.`;
        return respondOk([JSON.stringify(result), summary], { structuredContent: result });
    },
} as const);
