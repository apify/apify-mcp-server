import { z } from 'zod';

import log from '@apify/log';

import { HELPER_TOOLS } from '../../const.js';
import { REDACTED } from '../../resources/api_resources.js';
import type { InternalToolArgs, ToolDescriptionContext, ToolEntry, ToolInputSchema } from '../../types.js';
import { ALL_TOOLS_PRESENT, TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { getConsoleLinkContext } from '../../utils/console_link.js';
import { respondAborted, respondUserError } from '../../utils/mcp.js';
import { abortRunOnSignal, buildStartRunResponse, fetchActorRunData } from '../actors/actor_run_response.js';
import { callActorArgs, callOptionsSchema } from '../actors/call_actor.js';
import { isRecord } from '../api/apify_api_spec.js';
import { buildGetActorRunResponse } from '../runs/get_actor_run.js';
import { actorRunOutputSchema, anyJsonObjectSchema } from '../structured_output_schemas.js';
import { getTaskByIdOrName } from './task_helpers.js';

const callActorTaskArgs = z.object({
    taskId: z
        .string()
        .min(1)
        .describe(
            'The task to run: its ID, its name (resolved against your own tasks), or "username/task-name" for a task owned by someone else.',
        ),
    input: anyJsonObjectSchema
        .optional()
        .describe(
            "Input fields to override for this run. Only the fields given are replaced; the rest keep the task's saved values. Omit to run with the saved input.",
        ),
    waitSecs: callActorArgs.shape.waitSecs,
    callOptions: callOptionsSchema
        .optional()
        .describe(
            "Optional run config overriding the task's saved run options: memory (MB), timeout (s), build, maxItems (pay-per-result cap), maxTotalChargeUsd (pay-per-event cap).",
        ),
});

/** `keys` of `record` that are set, each a string, number, or boolean as is and any other value as `REDACTED`. */
function pickLoggedValues(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
    return Object.fromEntries(
        keys.flatMap((key) => {
            const value = record[key];
            if (value === undefined) return [];
            return [[key, ['string', 'number', 'boolean'].includes(typeof value) ? value : REDACTED]];
        }),
    );
}

/**
 * The logged copy of the arguments (`redactArgs`), built as an allowlist. `input` is logged as `REDACTED`: it can
 * hold secrets, such as an API key the task's Actor takes.
 */
function redactCallActorTaskArgs(args: Record<string, unknown>): Record<string, unknown> {
    const { input, callOptions } = args;
    return {
        ...pickLoggedValues(args, ['taskId', 'waitSecs']),
        ...(callOptions !== undefined && {
            callOptions: isRecord(callOptions)
                ? pickLoggedValues(callOptions, callOptionsSchema.keyof().options)
                : REDACTED,
        }),
        ...(input !== undefined && { input: REDACTED }),
    };
}

function buildDescription({ hasTool }: ToolDescriptionContext): string {
    return `Run an Actor with the preset input and run options of a saved Actor task.
Fields given in \`input\` or \`callOptions\` override only those fields for this run; the task itself is not changed.
Waits up to waitSecs (default 30s) for completion; returns run status and storage IDs, never the output rows.
${hasTool(HELPER_TOOLS.DATASET_GET_ITEMS) ? `Use ${HELPER_TOOLS.DATASET_GET_ITEMS} with the datasetId to fetch results.\n` : ''}
USAGE:
- Use when the user wants to run a saved task.
- Use \`waitSecs: 0\` to start the run and return immediately for long-running tasks.

USAGE EXAMPLES:
- user_input: Run my task my-example-task
- user_input: Run task E2jjCZBezvAZnX8Rb with maxResults set to 10`;
}

/**
 * https://docs.apify.com/api/v2/actor-task-runs-post
 */
export const callActorTask: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_TASK_CALL,
    title: 'Call Actor task',
    description: buildDescription(ALL_TOOLS_PRESENT),
    buildDescription,
    inputSchema: z.toJSONSchema(callActorTaskArgs) as ToolInputSchema,
    outputSchema: actorRunOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(callActorTaskArgs)),
    redactArgs: redactCallActorTaskArgs,
    annotations: {
        title: 'Call Actor task',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
    },
    execution: {
        taskSupport: 'optional',
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client, signal: abortSignal } = toolArgs;
        const parsed = callActorTaskArgs.parse(args);
        // Task mode waits until terminal, as in call-actor.
        const waitSecs = toolArgs.taskMode ? undefined : parsed.waitSecs;

        const task = await getTaskByIdOrName(client, parsed.taskId);
        if (!task) {
            return respondUserError(`Task ${parsed.taskId} was not found.`);
        }

        if (abortSignal?.aborted) return respondAborted();

        const actorRun = await client.task(task.id).start(parsed.input, parsed.callOptions);
        log.debug('Started Actor task run', {
            taskId: task.id,
            runId: actorRun.id,
            mcpSessionId: toolArgs.mcpSessionId,
            waitSecs,
        });

        // Abort can arrive while start() was in flight — abort the newly created run.
        if (abortSignal?.aborted) {
            await abortRunOnSignal(actorRun.id, client);
            return respondAborted();
        }

        const linkContext = await getConsoleLinkContext(toolArgs.apifyToken, client);

        // The task carries only the Actor ID; the wait path below looks up the Actor's full name.
        if (waitSecs === 0) {
            const response = buildStartRunResponse({ actorName: task.actId, actorRun, linkContext });
            return { ...response, toolTelemetry: { actorId: task.actId } };
        }

        const fetchResult = await fetchActorRunData({
            runId: actorRun.id,
            waitSecs,
            client,
            progressTracker: toolArgs.progressTracker,
            abortSignal,
            mcpSessionId: toolArgs.mcpSessionId,
            onAbort: abortRunOnSignal,
        });

        if ('aborted' in fetchResult) return respondAborted();
        if ('error' in fetchResult) return fetchResult.error;

        return {
            ...buildGetActorRunResponse({ ...fetchResult.result, linkContext }),
            toolTelemetry: { actorId: task.actId },
        };
    },
} as const);
