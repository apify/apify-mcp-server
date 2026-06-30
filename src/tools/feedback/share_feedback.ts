import { z } from 'zod';

import { HelperTools } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { buildMCPResponse } from '../../utils/mcp.js';

const SHARE_FEEDBACK_DESCRIPTION = `Report a problem or share feedback about Apify's MCP tools and Actors.

Use this when:
- You got stuck, or a tool/Actor response was confusing, wrong, or missing information.
- You want to rate an Actor or tell us what worked well.

Privacy: do NOT include personal data, credentials, secrets, or verbatim private conversation \
content. Describe the issue in your own words.`;

const ACKNOWLEDGEMENT = `Feedback submitted. Thank you — this helps improve Apify's tools.`;

/**
 * One-line recruiting footer appended to the descriptions of tools where agents commonly get stuck
 * (call-actor, search-actors, fetch-actor-details) so the feedback channel is discoverable.
 */
export const SHARE_FEEDBACK_FOOTER = `If you got stuck, or this tool's response was confusing or wrong, use ${HelperTools.FEEDBACK_SHARE} to report it — you can also use it to rate an Actor.`;

const shareFeedbackArgsSchema = z.object({
    message: z.string().min(1).describe('What happened: the problem you hit, or what went well or badly. Required.'),
    actorId: z.string().optional().describe('Optional. The Actor this feedback is about, e.g. apify/rag-web-browser.'),
    actorRunId: z.string().optional().describe('Optional. The Actor run this feedback is about.'),
    npsRating: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .describe(
            'Optional. How likely you are to recommend this Actor or experience to other agents, from 0 (very unlikely) to 10 (very likely).',
        ),
    relatedTools: z.string().array().optional().describe('Optional. Names of the MCP tools involved in this feedback.'),
});

const shareFeedbackInputSchema = z.toJSONSchema(shareFeedbackArgsSchema) as ToolInputSchema;

export const shareFeedback: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HelperTools.FEEDBACK_SHARE,
    title: 'Share feedback',
    description: SHARE_FEEDBACK_DESCRIPTION,
    inputSchema: shareFeedbackInputSchema,
    ajvValidate: compileSchema(shareFeedbackInputSchema),
    paymentRequired: false,
    annotations: {
        title: 'Share feedback',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args } = toolArgs;

        shareFeedbackArgsSchema.parse(args);

        return buildMCPResponse({ texts: [ACKNOWLEDGEMENT] });
    },
} as const);
