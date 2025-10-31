import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

import { ApifyClient } from '../apify-client.js';
import { HelperTools } from '../const.js';
import type { InternalToolArgs, McpInputSchema, ToolEntry } from '../types.js';
import { ajv } from '../utils/ajv.js';

const getActorRunArgs = z.object({
    runId: z.string()
        .min(1)
        .describe('The ID of the Actor run.'),
});

const abortRunArgs = z.object({
    runId: z.string()
        .min(1)
        .describe('The ID of the Actor run to abort.'),
    gracefully: z.boolean().optional().describe('If true, the Actor run will abort gracefully with a 30-second timeout.'),
});

/**
 * https://docs.apify.com/api/v2/actor-run-get
 */
export const getActorRun: ToolEntry = {
    type: 'internal',
    name: HelperTools.ACTOR_RUNS_GET,
    description: `Get detailed information about a specific Actor run by runId.
The results will include run metadata (status, timestamps), performance stats, and resource IDs (datasetId, keyValueStoreId, requestQueueId).

USAGE:
- Use when you need to inspect run status or retrieve associated resource IDs (e.g., datasetId for output).

USAGE EXAMPLES:
- user_input: Show details of run y2h7sK3Wc
- user_input: What is the datasetId for run y2h7sK3Wc?`,
    inputSchema: zodToJsonSchema(getActorRunArgs) as McpInputSchema,
    ajvValidate: ajv.compile(zodToJsonSchema(getActorRunArgs)),
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyToken } = toolArgs;
        const parsed = getActorRunArgs.parse(args);
        const client = new ApifyClient({ token: apifyToken });
        const v = await client.run(parsed.runId).get();
        if (!v) {
            return { content: [{ type: 'text', text: `Run with ID '${parsed.runId}' not found.` }] };
        }
        return { content: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(v)}\n\`\`\`` }] };
    },
} as const;

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
export const getActorRunLog: ToolEntry = {
    type: 'internal',
    name: HelperTools.ACTOR_RUNS_LOG,
    description: `Retrieve recent log lines for a specific Actor run.
The results will include the last N lines of the run's log output (plain text).

USAGE:
- Use when you need to inspect recent logs to debug or monitor a run.

USAGE EXAMPLES:
- user_input: Show last 20 lines of logs for run y2h7sK3Wc
- user_input: Get logs for run y2h7sK3Wc`,
    inputSchema: zodToJsonSchema(GetRunLogArgs) as McpInputSchema,
    ajvValidate: ajv.compile(zodToJsonSchema(GetRunLogArgs)),
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyToken } = toolArgs;
        const parsed = GetRunLogArgs.parse(args);
        const client = new ApifyClient({ token: apifyToken });
        const v = await client.run(parsed.runId).log().get() ?? '';
        const lines = v.split('\n');
        const text = lines.slice(lines.length - parsed.lines - 1, lines.length).join('\n');
        return { content: [{ type: 'text', text }] };
    },
} as const;

/**
 * https://docs.apify.com/api/v2/actor-run-abort-post
 */
export const abortActorRun: ToolEntry = {
    type: 'internal',
    name: HelperTools.ACTOR_RUNS_ABORT,
    description: `Abort an Actor run that is currently starting or running.
For runs with status FINISHED, FAILED, ABORTING, or TIMED-OUT, this call has no effect.
The results will include the updated run details after the abort request.

USAGE:
- Use when you need to stop a run that is taking too long or misconfigured.

USAGE EXAMPLES:
- user_input: Abort run y2h7sK3Wc
- user_input: Gracefully abort run y2h7sK3Wc`,
    inputSchema: zodToJsonSchema(abortRunArgs) as McpInputSchema,
    ajvValidate: ajv.compile(zodToJsonSchema(abortRunArgs)),
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyToken } = toolArgs;
        const parsed = abortRunArgs.parse(args);
        const client = new ApifyClient({ token: apifyToken });
        const v = await client.run(parsed.runId).abort({ gracefully: parsed.gracefully });
        return { content: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(v)}\n\`\`\`` }] };
    },
} as const;
