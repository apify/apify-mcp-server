import type { TaskUpdateData } from 'apify-client';
import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import type { InternalToolArgs, ToolDescriptionContext, ToolEntry, ToolInputSchema } from '../../types.js';
import { ALL_TOOLS_PRESENT, TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { respondOk, respondUserError } from '../../utils/mcp.js';
import { actorTaskOutputSchema } from '../structured_output_schemas.js';
import {
    getTaskByIdOrName,
    isAmbiguousResourceId,
    publicConfigSchema,
    taskNameSchema,
    taskResult,
    toSafeResourceId,
} from './task_helpers.js';

const updateActorTaskArgs = z.object({
    taskId: z
        .string()
        .min(1)
        .describe(
            'The task to update: its ID, its name (resolved against your own tasks), or "username/task-name" for a task owned by someone else.',
        ),
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

function buildDescription({ hasTool }: ToolDescriptionContext): string {
    const publicationTools = [HELPER_TOOLS.ACTOR_TASK_PUBLISH, HELPER_TOOLS.ACTOR_TASK_UNPUBLISH].filter((name) =>
        hasTool(name),
    );
    return `Update a saved Actor task: its input, run options, or the public display configuration (\`publicConfig\`) of its landing page.
This does not publish or unpublish the task${publicationTools.length ? ` — use ${publicationTools.join(' and ')} for that` : ''}.
To publish a task, \`publicConfig.inputSchemaFields\` (at least one field name from the task input) and
\`publicConfig.datasetView\` must be set here first. Updating \`publicConfig\` requires write access to the task's Actor.

USAGE:
- Use to change a task's input or run options.
- Use to fill in the public display configuration before publishing a task.

USAGE EXAMPLES:
- user_input: Change my task my-task to use the beta build
- user_input: Set up my-task for publishing with the overview dataset view`;
}

/**
 * https://docs.apify.com/api/v2/actor-task-put
 */
export const updateActorTask: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_TASK_UPDATE,
    title: 'Update Actor task',
    description: buildDescription(ALL_TOOLS_PRESENT),
    buildDescription,
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

        const optionsUpdate = {
            ...(build !== undefined && { build }),
            ...(timeoutSecs !== undefined && { timeoutSecs }),
            ...(memoryMbytes !== undefined && { memoryMbytes }),
        };
        const hasOptions = Object.keys(optionsUpdate).length > 0;

        // The pre-read serves two cases: the API completely replaces `options` (unlike
        // `publicConfig`, which it merges), so an options update must merge with the stored value;
        // and an ambiguous taskId (an ID-shaped name) must be resolved to the real ID by lookup.
        let resolvedTaskId = toSafeResourceId(taskId);
        let storedOptions;
        if (hasOptions || isAmbiguousResourceId(taskId)) {
            const storedTask = await getTaskByIdOrName(client, taskId);
            // Report the missing task from this read rather than letting the update fail later with
            // a rawer error.
            if (!storedTask) {
                return respondUserError(`Task ${taskId} was not found.`);
            }
            resolvedTaskId = storedTask.id;
            storedOptions = storedTask.options;
        }

        const update: TaskUpdateData = {
            ...(name && { name }),
            ...(title !== undefined && { title }),
            ...(description !== undefined && { description }),
            ...(input && { input }),
            ...(hasOptions && { options: { ...storedOptions, ...optionsUpdate } }),
            ...(publicConfig && { publicConfig }),
        };

        const task = await client.task(resolvedTaskId).update(update);

        const result = taskResult(task);
        const summary = `Updated task "${result.name}" (ID: ${result.taskId}).`;
        return respondOk([JSON.stringify(result), summary], { structuredContent: result });
    },
} as const);
