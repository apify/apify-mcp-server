import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { logLinesSchema, readLogTail, sliceLogTail } from '../../utils/log_tail.js';
import { respondOk, respondUserError } from '../../utils/mcp.js';
import { getActorRunLogToolOutputSchema } from '../structured_output_schemas.js';

const GetRunLogArgs = z.object({
    runId: z.string().describe('The ID of the Actor run.'),
    lines: logLinesSchema,
});

/**
 * https://docs.apify.com/api/v2/actor-run-log-get
 *  /v2/actor-runs/{runId}/log{?token}
 */
export const getActorRunLog: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_RUNS_LOG,
    title: 'Get Actor run log',
    description: `Retrieve recent log lines for a specific Actor run.
The results will include the last N lines of the run's log output (plain text).

USAGE:
- Use when you need to inspect recent logs to debug or monitor a run.

USAGE EXAMPLES:
- user_input: Show last 20 lines of logs for run y2h7sK3Wc
- user_input: Get logs for run y2h7sK3Wc`,
    inputSchema: z.toJSONSchema(GetRunLogArgs) as ToolInputSchema,
    outputSchema: getActorRunLogToolOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(GetRunLogArgs)),
    paymentRequired: true,
    annotations: {
        title: 'Get Actor run log',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client, signal } = toolArgs;
        const parsed = GetRunLogArgs.parse(args);
        const tail = await readLogTail(client, client.run(parsed.runId).log().url, signal);
        // The log endpoint 404s only when the run itself is missing; an existing run with no
        // output yet returns an empty string. So `undefined` here means "run not found" — do not
        // coalesce it back to '' (#1193).
        if (tail === undefined) {
            return respondUserError(`Run with ID '${parsed.runId}' not found.`);
        }
        const { text, note } = sliceLogTail(tail, parsed.lines);
        return respondOk(note ? [text, note] : text, { structuredContent: { log: text } });
    },
} as const);
