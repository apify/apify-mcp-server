import { Ajv } from 'ajv';
import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

import { ApifyClient } from '../apify-client.js';
import { HelperTools } from '../const.js';
import type { InternalTool, ToolWrap } from '../types.js';

const ajv = new Ajv({ coerceTypes: 'array', strict: false });

const GetRunArgs = z.object({
    runId: z.string().describe('The ID of the Actor run.'),
});

const AbortRunArgs = z.object({
    runId: z.string().describe('The ID of the Actor run to abort.'),
    gracefully: z.boolean().optional().describe('If true, the Actor run will abort gracefully with a 30-second timeout.'),
});

/**
 * https://docs.apify.com/api/v2/actor-run-get
 */
export const getActorRun: ToolWrap = {
    type: 'internal',
    tool: {
        name: HelperTools.ACTOR_RUNS_GET,
        actorFullName: HelperTools.ACTOR_RUNS_GET,
        description: 'Gets detailed information about a specific Actor run including its status, status message, metrics, and resources. '
            + 'The response includes run metadata (ID, status, status message, timestamps), performance stats (CPU, memory, network), '
            + 'resource IDs (dataset, key-value store, request queue), and configuration options.',
        inputSchema: zodToJsonSchema(GetRunArgs),
        ajvValidate: ajv.compile(zodToJsonSchema(GetRunArgs)),
        call: async (toolArgs) => {
            const { args, apifyToken } = toolArgs;
            const parsed = GetRunArgs.parse(args);
            const client = new ApifyClient({ token: apifyToken });
            const v = await client.run(parsed.runId).get();
            return { content: [{ type: 'text', text: JSON.stringify(v) }] };
        },
    } as InternalTool,
};

const GetRunLogArgs = z.object({
    runId: z.string().describe('The ID of the Actor run.'),
    lines: z.number()
        .max(50)
        .describe('Output the last NUM lines, instead of the last 10')
        .default(10),
});

/**
 * https://docs.apify.com/api/v2/actor-run-get
 *  /v2/actor-runs/{runId}/log{?token}
 */
export const getActorLog: ToolWrap = {
    type: 'internal',
    tool: {
        name: HelperTools.ACTOR_RUNS_LOG,
        actorFullName: HelperTools.ACTOR_RUNS_LOG,
        description: 'Retrieves logs for a specific Actor run. '
            + 'Returns the log content as plain text.',
        inputSchema: zodToJsonSchema(GetRunLogArgs),
        ajvValidate: ajv.compile(zodToJsonSchema(GetRunLogArgs)),
        call: async (toolArgs) => {
            const { args, apifyToken } = toolArgs;
            const parsed = GetRunLogArgs.parse(args);
            const client = new ApifyClient({ token: apifyToken });
            const v = await client.run(parsed.runId).log().get() ?? '';
            const lines = v.split('\n');
            const text = lines.slice(lines.length - parsed.lines - 1, lines.length).join('\n');
            return { content: [{ type: 'text', text }] };
        },
    } as InternalTool,
};

/**
 * https://docs.apify.com/api/v2/actor-run-abort-post
 */
export const abortActorRun: ToolWrap = {
    type: 'internal',
    tool: {
        name: HelperTools.ACTOR_RUNS_ABORT,
        actorFullName: HelperTools.ACTOR_RUNS_ABORT,
        description: 'Aborts an Actor run that is currently starting or running. '
            + 'For runs with status FINISHED, FAILED, ABORTING, or TIMED-OUT, this call has no effect. '
            + 'Returns the updated run details after aborting.',
        inputSchema: zodToJsonSchema(AbortRunArgs),
        ajvValidate: ajv.compile(zodToJsonSchema(AbortRunArgs)),
        call: async (toolArgs) => {
            const { args, apifyToken } = toolArgs;
            const parsed = AbortRunArgs.parse(args);
            const client = new ApifyClient({ token: apifyToken });
            const v = await client.run(parsed.runId).abort({ gracefully: parsed.gracefully });
            return { content: [{ type: 'text', text: JSON.stringify(v) }] };
        },
    } as InternalTool,
};
