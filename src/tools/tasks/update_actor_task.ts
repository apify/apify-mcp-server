import type { TaskUpdateData } from 'apify-client';
import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { respondOk } from '../../utils/mcp.js';
import { actorTaskOutputSchema } from '../structured_output_schemas.js';
import { publicConfigSchema, taskNameSchema, taskResult } from './task_helpers.js';

const updateActorTaskArgs = z.object({
    taskId: z.string().min(1).describe('The ID or task-name of the task to update.'),
    name: taskNameSchema.optional().describe('New name of the task: 3-63 characters, letters, digits and dashes only.'),
    title: z.string().optional().describe('New human-readable title of the task.'),
    description: z.string().optional().describe('New short description of the task.'),
    input: z
        .object({})
        .passthrough()
        .optional()
        .describe('Replacement input JSON for the task. Replaces the stored input, it is not merged into it.'),
    build: z.string().optional().describe('Actor build tag or number to run, e.g. "latest".'),
    timeoutSecs: z.number().int().min(0).optional().describe('Run timeout in seconds; 0 means no timeout.'),
    memoryMbytes: z.number().int().positive().optional().describe('Memory limit for the run in megabytes.'),
    publicConfig: publicConfigSchema
        .optional()
        .describe(
            'Public display configuration of the task landing page. Provided fields are merged into the stored configuration; the publication state itself is not changed here.',
        ),
});

/**
 * https://docs.apify.com/api/v2/actor-task-put
 */
export const updateActorTask: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_TASK_UPDATE,
    title: 'Update Actor task',
    description: `Update a saved Actor task: its input, run options, or the public display configuration (\`publicConfig\`) of its landing page.
This does not publish or unpublish the task — use ${HELPER_TOOLS.ACTOR_TASK_PUBLISH} and ${HELPER_TOOLS.ACTOR_TASK_UNPUBLISH} for that.
To publish a task, \`publicConfig.inputSchemaFields\` (at least one field name from the task input) and
\`publicConfig.datasetView\` must be set here first. Updating \`publicConfig\` requires write access to the task's Actor.

USAGE:
- Use to change a task's input or run options.
- Use to fill in the public display configuration before publishing a task.

USAGE EXAMPLES:
- user_input: Change my task my-task to use the beta build
- user_input: Set up my-task for publishing with the overview dataset view`,
    inputSchema: z.toJSONSchema(updateActorTaskArgs) as ToolInputSchema,
    outputSchema: actorTaskOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(updateActorTaskArgs)),
    annotations: {
        title: 'Update Actor task',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client } = toolArgs;
        const { taskId, name, title, description, input, build, timeoutSecs, memoryMbytes, publicConfig } =
            updateActorTaskArgs.parse(args);

        const options = { build, timeoutSecs, memoryMbytes };
        const hasOptions = Object.values(options).some((value) => value !== undefined);

        const update: TaskUpdateData = {
            ...(name && { name }),
            ...(title && { title }),
            ...(description && { description }),
            ...(input && { input }),
            ...(hasOptions && { options }),
            ...(publicConfig && { publicConfig }),
        };

        const task = await client.task(taskId).update(update);

        const result = taskResult(task);
        const summary = `Updated task "${result.name}" (ID: ${result.taskId}).`;
        return respondOk([JSON.stringify(result), summary], { structuredContent: result });
    },
} as const);
