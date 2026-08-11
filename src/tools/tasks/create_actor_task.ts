import type { TaskCreateData } from 'apify-client';
import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { respondOk } from '../../utils/mcp.js';
import { actorTaskOutputSchema } from '../structured_output_schemas.js';
import { publicConfigSchema, taskNameSchema, taskResult } from './task_helpers.js';

const createActorTaskArgs = z.object({
    actorId: z.string().min(1).describe('The ID or username~actor-name of the Actor to create the task for.'),
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

/**
 * https://docs.apify.com/api/v2/actor-tasks-post
 */
export const createActorTask: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_TASK_CREATE,
    title: 'Create Actor task',
    description: `Create a saved Actor task — a named, reusable Actor configuration (input plus run options).
The public display configuration (\`publicConfig\`) can be set here or later with ${HELPER_TOOLS.ACTOR_TASK_UPDATE};
either way the task is not published until you call ${HELPER_TOOLS.ACTOR_TASK_PUBLISH}.

USAGE:
- Use when the user wants to save an Actor configuration for repeated use.

USAGE EXAMPLES:
- user_input: Save this instagram-scraper config as a task called daily-posts
- user_input: Create a task for apify/rag-web-browser with my query`,
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

        const options = { build, timeoutSecs, memoryMbytes };
        const hasOptions = Object.values(options).some((value) => value !== undefined);

        const task = await client.tasks().create({
            actId: actorId,
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
