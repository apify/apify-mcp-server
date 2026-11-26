import { z } from 'zod';

import { FAILURE_CATEGORY, HELPER_TOOLS } from '../../const.js';
import type { ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { respondOk } from '../../utils/mcp.js';
import { sendFeedbackToolOutputSchema } from '../structured_output_schemas.js';

const SEND_FEEDBACK_DESCRIPTION = `Send feedback about Apify's MCP server, its tools, or Apify Actors to the Apify team. \
It covers Apify only: not other MCP servers, other tools, or the host app.

Reports can describe missing tools or Actors, errors, timeouts, confusing results, steps that took several attempts, \
or tasks that the available tools could not complete. Reports help fix the problem for other users. \
Feedback can also be positive, such as an Actor that worked as described.

Put what you were doing and what happened in "message", and classify it with "sentiment" and "category". \
Do NOT include personal data, credentials, secrets, or verbatim private conversation content — describe it in \
your own words.`;

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
        .describe(
            'What happened: what you were doing and the result. Required. ' +
                'Keep it to a few sentences (max 2000 characters).',
        ),
    sentiment: z
        .enum(['positive', 'negative', 'neutral'])
        .describe(
            'Overall tone: positive (something worked well), negative (something went wrong), ' +
                'or neutral (a suggestion or observation).',
        ),
    category: z
        .enum([
            'bug',
            'spec_mismatch',
            'readme_unclear',
            'missing_capability',
            'improvement',
            'worked_well',
            'account_or_billing',
            'other',
        ])
        .describe(
            'What the feedback is about. ' +
                'bug: an error, crash, timeout, or wrong result. ' +
                "spec_mismatch: an Actor run did not match the Actor's input schema or README. " +
                'readme_unclear: an Actor README or a tool description did not explain how to use it. ' +
                'missing_capability: no available tool or Actor could do the task. ' +
                'improvement: a suggestion that is not a bug. ' +
                'worked_well: a tool or Actor worked as described. ' +
                'account_or_billing: a plan, billing, usage-limit, or authentication issue with the Apify account. ' +
                'other: none of the above.',
        ),
    source: z
        .enum(['user', 'model'])
        .optional()
        .describe(
            'Optional. Who asked for this feedback to be sent: user (the user asked) ' +
                'or model (you decided to send it).',
        ),
    actorId: z
        .string()
        .max(200)
        .optional()
        .describe('Optional. The Actor this feedback is about, e.g. apify/rag-web-browser.'),
    actorRunId: z.string().max(200).optional().describe('Optional. The Actor run this feedback is about.'),
    relatedTools: z
        .string()
        .max(100)
        .array()
        .max(20)
        .optional()
        .describe('Optional. Names of the MCP tools involved in this feedback (up to 20).'),
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
