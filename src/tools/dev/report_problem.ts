import { z } from 'zod';

import { FAILURE_CATEGORY, HELPER_TOOLS } from '../../const.js';
import type { ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { respondOk } from '../../utils/mcp.js';
import { reportProblemToolOutputSchema } from '../structured_output_schemas.js';

const REPORT_PROBLEM_DESCRIPTION = `Report a problem with Apify's MCP tools or Actors to the Apify team.

Reports can describe missing tools or Actors, errors, timeouts, confusing results, or tasks that the available \
tools could not complete.

Put what you were doing and what went wrong in "message". Do NOT include personal data, credentials, \
secrets, or verbatim private conversation content — describe the issue in your own words.`;

const ACKNOWLEDGEMENT = `Problem reported. Thank you — this helps the Apify team improve its tools.`;

/** Describes reporting without requesting a call; see apify/apify-mcp-server#1597. */
export const REPORT_PROBLEM_NUDGE = `${HELPER_TOOLS.PROBLEM_REPORT} sends a description of this error to the Apify team.`;

/** Input, auth and approval failures are expected states, not defects to report; see apify/apify-mcp-server#1290. */
const NON_NUDGE_FAILURE_CATEGORIES = new Set<string>([
    FAILURE_CATEGORY.INVALID_INPUT,
    FAILURE_CATEGORY.PERMISSION_APPROVAL_REQUIRED,
    FAILURE_CATEGORY.AUTH,
]);

/** Returns a copy so appending the sentence does not mutate the original tool result. */
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
    return { ...r, content: [...r.content, { type: 'text', text: REPORT_PROBLEM_NUDGE }] } as T;
}

/**
 * Append the report-problem nudge to a failed tool result. Thin wrapper over
 * {@link appendReportProblemNudge} that fills in whether report-problem is served on this
 * connection, based on the caller's `tools` map; suppression by category/402 is handled inside
 * the helper.
 */
export function withReportProblemNudge<T>(params: {
    result: T;
    tools: Map<string, ToolEntry>;
    failingToolName: string | undefined;
    failureCategory?: string;
    failureHttpStatus?: number;
}): T {
    return appendReportProblemNudge(params.result, {
        failingToolName: params.failingToolName,
        available: params.tools.has(HELPER_TOOLS.PROBLEM_REPORT),
        failureCategory: params.failureCategory,
        failureHttpStatus: params.failureHttpStatus,
    });
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
    outputSchema: reportProblemToolOutputSchema,
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
        return respondOk(ACKNOWLEDGEMENT, { structuredContent: { reported: true } });
    },
} as const);
