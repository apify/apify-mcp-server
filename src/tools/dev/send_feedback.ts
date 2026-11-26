import { z } from 'zod';

import { FAILURE_CATEGORY, HELPER_TOOLS } from '../../const.js';
import type { ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { respondOk } from '../../utils/mcp.js';
import { sendFeedbackToolOutputSchema } from '../structured_output_schemas.js';

const SEND_FEEDBACK_DESCRIPTION = `Send feedback about a problem with Apify's MCP tools or Actors to the Apify team.

Reports can describe missing tools or Actors, errors, timeouts, confusing results, steps that took several attempts, \
or tasks that the available tools could not complete. Reports help fix the problem for other users.

Put what you were doing and what went wrong in "message". Do NOT include personal data, credentials, \
secrets, or verbatim private conversation content — describe the issue in your own words.`;

const ACKNOWLEDGEMENT = `Feedback sent. Thank you — this helps the Apify team improve its tools.`;

/** Offers reporting without ordering a call or putting it before the reply to the user; see apify/apify-mcp-server#1597. */
export const SEND_FEEDBACK_NUDGE = `If you cannot resolve this yourself, you can report it to the Apify team with \
${HELPER_TOOLS.FEEDBACK_SEND} (describe what you were doing and this error).`;

/** For INVALID_INPUT failures: some are real bugs (an Actor rejecting input that matches its schema), others friction worth reporting. */
export const SEND_FEEDBACK_INVALID_INPUT_NUDGE = `If this error looks like a bug, or was unclear or took several attempts to get \
past, you can report it to the Apify team with ${HELPER_TOOLS.FEEDBACK_SEND} (describe what you were doing and what went wrong).`;

/** Auth and approval failures are expected states the user resolves, not problems to report. */
const NON_NUDGE_FAILURE_CATEGORIES = new Set<string>([
    FAILURE_CATEGORY.PERMISSION_APPROVAL_REQUIRED,
    FAILURE_CATEGORY.AUTH,
]);

/** Returns a copy so appending the sentence does not mutate the original tool result. */
export function appendSendFeedbackNudge<T>(
    result: T,
    opts: { failingToolName?: string; available: boolean; failureCategory?: string; failureHttpStatus?: number },
): T {
    if (!opts.available) return result;
    if (opts.failingToolName === HELPER_TOOLS.FEEDBACK_SEND) return result;
    if (opts.failureHttpStatus === 402) return result; // payment required: billing state, not a defect
    if (opts.failureCategory !== undefined && NON_NUDGE_FAILURE_CATEGORIES.has(opts.failureCategory)) return result;
    const r = result as { isError?: unknown; content?: unknown };
    if (r?.isError !== true || !Array.isArray(r.content)) return result;
    const nudge =
        opts.failureCategory === FAILURE_CATEGORY.INVALID_INPUT
            ? SEND_FEEDBACK_INVALID_INPUT_NUDGE
            : SEND_FEEDBACK_NUDGE;
    return { ...r, content: [...r.content, { type: 'text', text: nudge }] } as T;
}

/**
 * Append the send-feedback nudge to a failed tool result. Thin wrapper over
 * {@link appendSendFeedbackNudge} that fills in whether send-feedback is served on this
 * connection, based on the caller's `tools` map; suppression by category/402 is handled inside
 * the helper.
 */
export function withSendFeedbackNudge<T>(params: {
    result: T;
    tools: Map<string, ToolEntry>;
    failingToolName: string | undefined;
    failureCategory?: string;
    failureHttpStatus?: number;
}): T {
    return appendSendFeedbackNudge(params.result, {
        failingToolName: params.failingToolName,
        available: params.tools.has(HELPER_TOOLS.FEEDBACK_SEND),
        failureCategory: params.failureCategory,
        failureHttpStatus: params.failureHttpStatus,
    });
}

export const sendFeedbackArgsSchema = z.object({
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

const sendFeedbackInputSchema = z.toJSONSchema(sendFeedbackArgsSchema) as ToolInputSchema;

export const sendFeedback: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.FEEDBACK_SEND,
    title: 'Send feedback',
    description: SEND_FEEDBACK_DESCRIPTION,
    inputSchema: sendFeedbackInputSchema,
    outputSchema: sendFeedbackToolOutputSchema,
    ajvValidate: compileSchema(sendFeedbackInputSchema),
    annotations: {
        title: 'Send feedback',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
    },
    call: async () => {
        return respondOk(ACKNOWLEDGEMENT, { structuredContent: { reported: true } });
    },
} as const);
