import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import { REDACTED } from '../../resources/api_resources.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { respondOk, respondUserError } from '../../utils/mcp.js';
import { getActorRunLogToolOutputSchema } from '../structured_output_schemas.js';

/** Largest `lines` value; `lines: 0` returns the entire log. */
export const RUN_LOG_LINES_MAX = 50;

/** Lines of the run log that a FAILED run response carries in `logTail`. */
export const RUN_LOG_TAIL_LINES = 30;

/** Character limit of `logTail`. */
export const RUN_LOG_TAIL_MAX_CHARS = 3000;

const APIFY_API_TOKEN_RE = /apify_api_[A-Za-z0-9]+/g;

/** The password of `scheme://user:password@host`, for example an Apify Proxy URL. */
const URL_PASSWORD_RE = /(:\/\/[^\s:/@]+:)[^\s/@]+@/g;

/**
 * Hide the secrets an Actor can print to its log: the session token, any Apify API token, and the
 * password in a URL such as an Apify Proxy URL. Other secrets an Actor prints cannot be detected.
 */
export function redactLogSecrets(text: string, sessionToken: string | undefined): string {
    const masked = sessionToken ? text.replaceAll(sessionToken, REDACTED) : text;
    return masked.replace(APIFY_API_TOKEN_RE, REDACTED).replace(URL_PASSWORD_RE, `$1${REDACTED}@`);
}

/**
 * The end of a run log: the last {@link RUN_LOG_TAIL_LINES} lines, redacted, then cut to
 * {@link RUN_LOG_TAIL_MAX_CHARS} by dropping whole leading lines. A last line that is still too long
 * keeps only its end. Redaction comes before the cut, so a cut never leaves part of a secret.
 */
export function buildLogTail(runLog: string, sessionToken: string | undefined): string {
    const lastLines = runLog.replace(/\n$/, '').split('\n').slice(-RUN_LOG_TAIL_LINES).join('\n');
    const redacted = redactLogSecrets(lastLines, sessionToken);
    const lines = redacted.split('\n');
    let { length } = redacted;
    while (lines.length > 1 && length > RUN_LOG_TAIL_MAX_CHARS) {
        length -= (lines.shift() as string).length + 1;
    }
    return lines.join('\n').slice(-RUN_LOG_TAIL_MAX_CHARS);
}

const GetRunLogArgs = z.object({
    runId: z.string().describe('The ID of the Actor run.'),
    lines: z
        .number()
        .max(RUN_LOG_LINES_MAX)
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
        const v = await client.run(parsed.runId).log().get();
        // The log endpoint 404s only when the run itself is missing; an existing run with no
        // output yet returns an empty string. So `undefined` here means "run not found" — do not
        // coalesce it back to '' (#1193).
        if (v === undefined) {
            return respondUserError(`Run with ID '${parsed.runId}' not found.`);
        }
        // Logs from the API end with a newline; drop it so the tail slice counts only content lines.
        const lines = v.replace(/\n$/, '').split('\n');
        const text = lines.slice(-parsed.lines).join('\n');
        return respondOk(text, { structuredContent: { log: text } });
    },
} as const);
