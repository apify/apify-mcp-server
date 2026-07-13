import { z } from 'zod';

import { FAILURE_CATEGORY, HELPER_TOOLS } from '../../const.js';
import type { ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { respondOk } from '../../utils/mcp.js';

const REPORT_PROBLEM_DESCRIPTION = `Report a problem with Apify's MCP tools or Actors to the Apify team.

Call it when:
- A tool or Actor is missing, errors, times out, or returns a confusing, wrong, or empty result.
- You cannot complete the user's request with the available tools.

Put what you were doing and what went wrong in "message". Do NOT include personal data, credentials, \
secrets, or verbatim private conversation content — describe the issue in your own words.`;

const ACKNOWLEDGEMENT = `Problem reported. Thank you — this helps the Apify team improve its tools.`;

/**
 * Nudge appended to any failed (isError) tool result so the agent is prompted to report the blocker
 * at the moment it decides what to do next — the single most effective discovery point, since the
 * server-instructions line alone does not reliably trigger a proactive call. Phrased "if you cannot
 * resolve this yourself" so it does not discourage retrying fixable errors.
 */
export const REPORT_PROBLEM_NUDGE = `If you cannot resolve this yourself, report it to the Apify team by calling ${HELPER_TOOLS.PROBLEM_REPORT} \
(describe what you were doing and this error) before telling the user you could not complete the task.`;

/**
 * Softer nudge for INVALID_INPUT failures (payment/standby short-circuits, actor input rejected at
 * runtime, etc.). Most of these are the agent's own mistake, so this doesn't push it to report before
 * giving up — but some are a genuine schema/Actor mismatch the agent would otherwise never think to
 * report, so it still surfaces the tool's existence.
 */
export const REPORT_PROBLEM_INVALID_INPUT_NUDGE = `If this looks like a bug rather than something fixable by adjusting your request, \
report it by calling ${HELPER_TOOLS.PROBLEM_REPORT} (describe what you were doing and this error).`;

/**
 * Failure categories that represent expected, user-resolvable control-flow states (pay, approve, fix
 * token) rather than potential Apify defects. The nudge is suppressed for these so it does not flood
 * the channel with paywalls/approvals or steer the agent to give up instead of surfacing the
 * payment/approval URL. `INVALID_INPUT` gets the softer {@link REPORT_PROBLEM_INVALID_INPUT_NUDGE}
 * instead of being suppressed outright — except when the failure carries a 402 HTTP status, a payment
 * (billing) state that is suppressed via `failureHttpStatus` in {@link appendReportProblemNudge} even
 * though 402 is classified `INVALID_INPUT`. `INTERNAL_ERROR` and an absent/unknown category still get
 * the full {@link REPORT_PROBLEM_NUDGE}.
 */
const NON_NUDGE_FAILURE_CATEGORIES = new Set<string>([
    FAILURE_CATEGORY.PERMISSION_APPROVAL_REQUIRED,
    FAILURE_CATEGORY.AUTH,
]);

/**
 * Append a report-problem nudge to a failed tool result's text content, returning a shallow copy with
 * a new `content` array (never mutates the input). Returns the original unchanged unless the result is
 * an error with a text `content[]`, `report-problem` is actually served (`available`), the failing tool
 * is not `report-problem` itself, `failureHttpStatus` is not 402 (a payment/billing state, suppressed
 * even though it is classified `INVALID_INPUT`), and `failureCategory` is not an expected,
 * user-resolvable state (see {@link NON_NUDGE_FAILURE_CATEGORIES}). Uses
 * {@link REPORT_PROBLEM_INVALID_INPUT_NUDGE} for `INVALID_INPUT` and {@link REPORT_PROBLEM_NUDGE}
 * otherwise.
 */
export function appendReportProblemNudge<T>(
    result: T,
    opts: { failingToolName?: string; available: boolean; failureCategory?: string; failureHttpStatus?: number },
): T {
    if (!opts.available) return result;
    if (opts.failingToolName === HELPER_TOOLS.PROBLEM_REPORT) return result;
    if (opts.failureHttpStatus === 402) return result; // payment required: billing state, not a defect
    if (opts.failureCategory !== undefined && NON_NUDGE_FAILURE_CATEGORIES.has(opts.failureCategory)) return result;
    const r = result as { isError?: unknown; content?: unknown };
    if (r?.isError !== true || !Array.isArray(r.content)) return result;
    const nudge =
        opts.failureCategory === FAILURE_CATEGORY.INVALID_INPUT
            ? REPORT_PROBLEM_INVALID_INPUT_NUDGE
            : REPORT_PROBLEM_NUDGE;
    return { ...r, content: [...r.content, { type: 'text', text: nudge }] } as T;
}

export const reportProblemArgsSchema = z.object({
    message: z
        .string()
        .min(1)
        .max(2000)
        .describe('What happened: the problem you hit. Required. Keep it to a few sentences (max 2000 characters).'),
    actorId: z
        .string()
        .max(200)
        .optional()
        .describe('Optional. The Actor this problem is about, e.g. apify/rag-web-browser.'),
    actorRunId: z.string().max(200).optional().describe('Optional. The Actor run this problem is about.'),
    relatedTools: z
        .string()
        .max(100)
        .array()
        .max(20)
        .optional()
        .describe('Optional. Names of the MCP tools involved in this problem (up to 20).'),
});

const reportProblemInputSchema = z.toJSONSchema(reportProblemArgsSchema) as ToolInputSchema;

export const reportProblem: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.PROBLEM_REPORT,
    title: 'Report a problem',
    description: REPORT_PROBLEM_DESCRIPTION,
    inputSchema: reportProblemInputSchema,
    ajvValidate: compileSchema(reportProblemInputSchema),
    paymentRequired: false,
    annotations: {
        title: 'Report a problem',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
    },
    call: async () => {
        return respondOk(ACKNOWLEDGEMENT);
    },
} as const);
