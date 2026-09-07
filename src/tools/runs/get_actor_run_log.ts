import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { respondOk, respondUserError } from '../../utils/mcp.js';
import { getActorRunLogToolOutputSchema } from '../structured_output_schemas.js';

const GetLogArgs = z.object({
    runId: z.string().optional().describe('The ID of the Actor run. Provide either runId or buildId.'),
    buildId: z.string().optional().describe('The ID of the Actor build. Provide either runId or buildId.'),
    lines: z
        .number()
        .max(50)
        .describe('Output the last NUM lines, instead of the last 10. Pass 0 to return the entire log.')
        .default(10),
});

type LogSource = { kind: 'Run' | 'Build'; id: string };

/** Exactly one of `runId` / `buildId` names the log to read; `undefined` when none or both were given. */
function toLogSource(parsed: z.infer<typeof GetLogArgs>): LogSource | undefined {
    if (parsed.runId !== undefined && parsed.buildId === undefined) return { kind: 'Run', id: parsed.runId };
    if (parsed.buildId !== undefined && parsed.runId === undefined) return { kind: 'Build', id: parsed.buildId };
    return undefined;
}

/**
 * https://docs.apify.com/api/v2/actor-run-log-get
 *  /v2/actor-runs/{runId}/log{?token}
 * https://docs.apify.com/api/v2/actor-build-log-get
 *  /v2/actor-builds/{buildId}/log
 */
export const getActorRunLog: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_RUNS_LOG,
    title: 'Get Actor run or build log',
    description: `Retrieve recent log lines for a specific Actor run or Actor build.
Pass exactly one of runId or buildId. The results will include the last N lines of the log output (plain text).

USAGE:
- Use when you need to inspect recent logs to debug or monitor a run.
- Use when a build failed and you need the build log to find the error.

USAGE EXAMPLES:
- user_input: Show last 20 lines of logs for run y2h7sK3Wc
- user_input: Get logs for run y2h7sK3Wc
- user_input: Why did build 7aB3xYz9Kq fail?`,
    inputSchema: z.toJSONSchema(GetLogArgs) as ToolInputSchema,
    outputSchema: getActorRunLogToolOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(GetLogArgs)),
    paymentRequired: true,
    annotations: {
        title: 'Get Actor run or build log',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client } = toolArgs;
        const parsed = GetLogArgs.parse(args);
        // Checked here, not in the schema: the JSON Schema AJV validates before call() cannot express "exactly one of".
        const source = toLogSource(parsed);
        if (!source) {
            return respondUserError('Provide exactly one of runId or buildId.');
        }
        const v =
            source.kind === 'Run' ? await client.run(source.id).log().get() : await client.build(source.id).log().get();
        // The log endpoint 404s only when the run or build itself is missing; an existing one with no
        // output yet returns an empty string. So `undefined` here means "not found"; do not
        // coalesce it back to '' (#1193).
        if (v === undefined) {
            return respondUserError(`${source.kind} with ID '${source.id}' not found.`);
        }
        // Logs from the API end with a newline; drop it so the tail slice counts only content lines.
        const lines = v.replace(/\n$/, '').split('\n');
        const text = lines.slice(-parsed.lines).join('\n');
        return respondOk(text, { structuredContent: { log: text } });
    },
} as const);
