/**
 * Actor run tools — get-actor-run (adapter), get-actor-run-log, and abort-actor-run.
 *
 * The get-actor-run tool has been split into mode-specific variants:
 * - `default/get-actor-run.ts` — full JSON dump without widget metadata
 * - `openai/get-actor-run.ts` — abbreviated text with widget metadata
 * - `core/get-actor-run-common.ts` — shared schema, metadata, and data-fetching logic
 *
 * The getActorRunLog and abortActorRun tools are mode-independent and remain here.
 * PR #4 will wire variants directly into the category registry, making the adapter unnecessary.
 */
import { z } from 'zod';

import { createApifyClientWithSkyfireSupport } from '../apify-client.js';
import { HelperTools } from '../const.js';
import type { HelperTool, InternalToolArgs, ToolEntry, ToolInputSchema } from '../types.js';
import { compileSchema } from '../utils/ajv.js';
import { defaultGetActorRun } from './default/get-actor-run.js';
import { openaiGetActorRun } from './openai/get-actor-run.js';

const defaultVariant = defaultGetActorRun as HelperTool;

/**
 * Adapter get-actor-run tool that dispatches to the correct mode-specific variant at runtime.
 */
export const getActorRun: ToolEntry = {
    ...defaultVariant,
    call: async (toolArgs: InternalToolArgs) => {
        const variant = (toolArgs.apifyMcpServer.options.uiMode === 'openai'
            ? openaiGetActorRun
            : defaultGetActorRun) as HelperTool;
        return variant.call(toolArgs);
    },
};

// --- Mode-independent tools below ---

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
    inputSchema: z.toJSONSchema(GetRunLogArgs) as ToolInputSchema,
    // It does not make sense to add structured output here since the log API just returns plain text
    /**
     * Allow additional properties for Skyfire mode to pass `skyfire-pay-id`.
     */
    ajvValidate: compileSchema({ ...z.toJSONSchema(GetRunLogArgs), additionalProperties: true }),
    requiresSkyfirePayId: true,
    annotations: {
        title: 'Get Actor run log',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyToken, apifyMcpServer } = toolArgs;
        const parsed = GetRunLogArgs.parse(args);

        const client = createApifyClientWithSkyfireSupport(apifyMcpServer, args, apifyToken);
        const v = await client.run(parsed.runId).log().get() ?? '';
        const lines = v.split('\n');
        const text = lines.slice(lines.length - parsed.lines - 1, lines.length).join('\n');
        return { content: [{ type: 'text', text }] };
    },
} as const;

const abortRunArgs = z.object({
    runId: z.string()
        .min(1)
        .describe('The ID of the Actor run to abort.'),
    gracefully: z.boolean().optional().describe('If true, the Actor run will abort gracefully with a 30-second timeout.'),
});

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
    inputSchema: z.toJSONSchema(abortRunArgs) as ToolInputSchema,
    /**
     * Allow additional properties for Skyfire mode to pass `skyfire-pay-id`.
     */
    ajvValidate: compileSchema({ ...z.toJSONSchema(abortRunArgs), additionalProperties: true }),
    requiresSkyfirePayId: true,
    annotations: {
        title: 'Abort Actor run',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyToken, apifyMcpServer } = toolArgs;
        const parsed = abortRunArgs.parse(args);

        const client = createApifyClientWithSkyfireSupport(apifyMcpServer, args, apifyToken);
        const v = await client.run(parsed.runId).abort({ gracefully: parsed.gracefully });
        return { content: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(v)}\n\`\`\`` }] };
    },
} as const;
