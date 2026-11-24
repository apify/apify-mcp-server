import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import { redactLogSecrets } from '../../resources/api_resources.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { type LogTail, logLinesSchema, readLogTail, sliceLogTail } from '../../utils/log_tail.js';
import { respondOk, respondUserError } from '../../utils/mcp.js';
import { getActorRunLogToolOutputSchema } from '../structured_output_schemas.js';

/** Lines of the run log that a FAILED run response carries in `logTail`. */
export const RUN_LOG_TAIL_LINES = 30;

/** Character limit of `logTail`. */
export const RUN_LOG_TAIL_MAX_CHARS = 3000;

/**
 * The end of a run log, from `readLogTail`: the last {@link RUN_LOG_TAIL_LINES} lines, redacted, then cut to
 * {@link RUN_LOG_TAIL_MAX_CHARS} by dropping whole leading lines. A last line that is still too long
 * keeps only its end. Redaction comes before the cut, so a cut never leaves part of a secret.
 */
export function buildLogTail(tail: LogTail, sessionToken: string | undefined): string {
    const redacted = redactLogSecrets(sliceLogTail(tail, RUN_LOG_TAIL_LINES).text, sessionToken);
    const lines = redacted.split('\n');
    let { length } = redacted;
    while (lines.length > 1 && length > RUN_LOG_TAIL_MAX_CHARS) {
        length -= lines.shift()!.length + 1;
    }
    return lines.join('\n').slice(-RUN_LOG_TAIL_MAX_CHARS);
}

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
