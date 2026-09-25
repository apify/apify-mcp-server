import dedent from 'dedent';
import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import type { InternalToolArgs, ToolDescriptionContext, ToolEntry, ToolInputSchema } from '../../types.js';
import { ALL_TOOLS_PRESENT, TOOL_TYPE } from '../../types.js';
import { compileSchema, fixZodSchemaRequired } from '../../utils/ajv.js';
import { respondOk } from '../../utils/mcp.js';
import { apifyApiSearchOutputSchema } from '../structured_output_schemas.js';
import { fetchApiOperationIndex, searchApiOperations } from './apify_api_spec.js';

const searchApifyApiArgs = z.object({
    query: z
        .string()
        .min(1)
        .describe('Keywords for what the operation does, for example "list webhooks" or "update dataset".'),
    limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .describe('Maximum number of operations to return. Default is 10. Maximum is 20.')
        .default(10),
});

function buildDescription({ hasTool }: ToolDescriptionContext): string {
    const callTools = [hasTool(HELPER_TOOLS.API_READ) && `${HELPER_TOOLS.API_READ} for read access`].filter(Boolean);
    const nextSteps = [
        hasTool(HELPER_TOOLS.API_OPERATION_FETCH) && `get its parameters with ${HELPER_TOOLS.API_OPERATION_FETCH}`,
        callTools.length > 0 && `call it with ${callTools.join(' or ')}`,
    ].filter(Boolean);
    const nextStepsSentence = nextSteps.length > 0 ? `\nAfter finding an operation, ${nextSteps.join(', then ')}.` : '';
    return dedent`
        Search the Apify API reference for operations by keywords. Returns each operation's ID, method,
        path, summary, and access: read, write, or unavailable with the reason the API tools do not call it.${nextStepsSentence}
        Prefer a dedicated Apify tool when one does what the user asks.

        USAGE:
        - Use when no dedicated tool does what the user asks and the Apify API might.
        - Tell the user the reason when the operation they need is unavailable.

        USAGE EXAMPLES:
        - user_input: List the webhooks on my account
        - user_input: Rename my dataset to leads-2026
        - user_input: How much of my monthly usage have I spent?
    `;
}

/**
 * Searches the operations of the published Apify API spec, https://docs.apify.com/api/v2.
 */
export const searchApifyApi: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.API_SEARCH,
    title: 'Search Apify API',
    description: buildDescription(ALL_TOOLS_PRESENT),
    buildDescription,
    inputSchema: fixZodSchemaRequired(z.toJSONSchema(searchApifyApiArgs)) as ToolInputSchema,
    outputSchema: apifyApiSearchOutputSchema,
    ajvValidate: compileSchema(fixZodSchemaRequired(z.toJSONSchema(searchApifyApiArgs))),
    annotations: {
        title: 'Search Apify API',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const parsed = searchApifyApiArgs.parse(toolArgs.args);
        const index = await fetchApiOperationIndex();
        const operations = searchApiOperations(index, parsed.query, parsed.limit).map((operation) => ({
            operationId: operation.operationId,
            method: operation.method,
            path: operation.path,
            summary: operation.summary,
            access: operation.access,
            ...(operation.unavailableReason && { unavailableReason: operation.unavailableReason }),
        }));
        const result = { operations };
        const summary =
            operations.length > 0
                ? `Found ${operations.length} API operations for "${parsed.query}".`
                : `No API operation matches "${parsed.query}". Try other keywords.`;
        return respondOk([JSON.stringify(result), summary], { structuredContent: result });
    },
} as const);
