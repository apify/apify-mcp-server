import type { TaskCreateData } from 'apify-client';
import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import type { InternalToolArgs, ToolDescriptionContext, ToolEntry, ToolInputSchema } from '../../types.js';
import { ALL_TOOLS_PRESENT, TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { respondOk } from '../../utils/mcp.js';
import { actorTaskOutputSchema } from '../structured_output_schemas.js';
import { publicConfigSchema, taskNameSchema, taskResult, toSafeResourceId } from './task_helpers.js';

const createActorTaskArgs = z.object({
    actorId: z
        .string()
        .min(1)
        .describe(
            'The Actor to create the task for: its ID, its name (resolved against your own Actors), or "username/actor-name" for an Actor owned by someone else.',
        ),
    name: taskNameSchema
        .optional()
        .describe(
            'Name of the task, unique within the account: 3-63 characters, letters, digits and dashes only (e.g. "my-task"). Generated from the Actor name when omitted.',
        ),
    input: z
        .looseObject({})
        .optional()
        .describe(
            `The input JSON the task runs the Actor with. Use ${HELPER_TOOLS.ACTOR_GET_DETAILS} to get the Actor's input schema first.`,
        ),
    title: z.string().optional().describe('Human-readable title of the task.'),
    description: z.string().optional().describe('Short description of what the task does.'),
    build: z.string().optional().describe('Actor build tag or number to run, e.g. "latest".'),
    timeoutSecs: z.number().int().min(0).optional().describe('Run timeout in seconds; 0 means no timeout.'),
    memoryMbytes: z.number().int().positive().optional().describe('Memory limit for the run in megabytes.'),
    publicConfig: publicConfigSchema
        .optional()
        .describe(
            "Public display configuration of the task's landing page. Setting it does not publish the task and requires write access to the Actor.",
        ),
});

function buildDescription({ hasTool }: ToolDescriptionContext): string {
    return `Create a saved Actor task — a named, reusable configuration of an Actor that stores its
input and run options such as the build, memory, and timeout. Tasks are useful for repeated or scheduled
jobs, because the user does not have to configure the Actor again for every run.

Creating a task does not make it public. The public display configuration (\`publicConfig\`) can be set \
here${hasTool(HELPER_TOOLS.ACTOR_TASK_UPDATE) ? ` or later with ${HELPER_TOOLS.ACTOR_TASK_UPDATE}` : ''}; either \
way the task stays private until it is published${hasTool(HELPER_TOOLS.ACTOR_TASK_PUBLISH) ? ` with ${HELPER_TOOLS.ACTOR_TASK_PUBLISH}` : ''}.

USAGE:
- Use when the user wants to save an Actor configuration for repeated use.

USAGE EXAMPLES:
- user_input: Save this instagram-scraper config as a task called daily-posts`;
}

/**
 * https://docs.apify.com/api/v2/actor-tasks-post
 */
export const createActorTask: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_TASK_CREATE,
    title: 'Create Actor task',
    description: buildDescription(ALL_TOOLS_PRESENT),
    buildDescription,
    inputSchema: z.toJSONSchema(createActorTaskArgs) as ToolInputSchema,
    outputSchema: actorTaskOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(createActorTaskArgs)),
    annotations: {
        title: 'Create Actor task',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client } = toolArgs;
        const { actorId, name, input, title, description, build, timeoutSecs, memoryMbytes, publicConfig } =
            createActorTaskArgs.parse(args);

        const options = {
            ...(build !== undefined && { build }),
            ...(timeoutSecs !== undefined && { timeoutSecs }),
            ...(memoryMbytes !== undefined && { memoryMbytes }),
        };
        const hasOptions = Object.keys(options).length > 0;

        const task = await client.tasks().create({
            actId: toSafeResourceId(actorId),
            ...(name && { name }),
            ...(input && { input }),
            ...(title && { title }),
            ...(description && { description }),
            ...(hasOptions && { options }),
            ...(publicConfig && { publicConfig }),
        } satisfies TaskCreateData);

        const result = taskResult(task);
        const summary = `Created task "${result.name}" (ID: ${result.taskId}) for Actor ${result.actorId}.`;
        return respondOk([JSON.stringify(result), summary], { structuredContent: result });
    },
} as const);
