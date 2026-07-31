import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { respondOk } from '../../utils/mcp.js';
import { getActorRunLogToolOutputSchema } from '../structured_output_schemas.js';

const GetRunLogArgs = z.object({
    runId: z.string().describe('The ID of the Actor run.'),
    lines: z
        .number()
        .max(50)
        .describe('Output the last NUM lines, instead of the last 10. Pass 0 to return the entire log.')
        .default(10),
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
        const { args, apifyClient: client } = toolArgs;
        const parsed = GetRunLogArgs.parse(args);
        const v = (await client.run(parsed.runId).log().get()) ?? '';
        // Logs from the API end with a newline; drop it so the tail slice counts only content lines.
        const lines = v.replace(/\n$/, '').split('\n');
        const text = lines.slice(-parsed.lines).join('\n');
        return respondOk(text, { structuredContent: { log: text } });
    },
} as const);
