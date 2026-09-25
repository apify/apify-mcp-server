import dedent from 'dedent';
import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import type { InternalToolArgs, ToolDescriptionContext, ToolEntry, ToolInputSchema } from '../../types.js';
import { ALL_TOOLS_PRESENT, TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { respondOk, respondUserError } from '../../utils/mcp.js';
import { apifyApiOperationOutputSchema } from '../structured_output_schemas.js';
import { apiCallArgsShape, formatOperationNotFoundMessage } from './apify_api_request.js';
import { fetchApiOperationIndex } from './apify_api_spec.js';

const fetchApifyApiOperationArgs = z.object({
    operationId: apiCallArgsShape.operationId,
});

function buildDescription({ hasTool }: ToolDescriptionContext): string {
    const findOperation = hasTool(HELPER_TOOLS.API_SEARCH)
        ? ` Find the operation ID with ${HELPER_TOOLS.API_SEARCH}.`
        : '';
    return dedent`
        Get one Apify API operation: its method, path, description, path and query parameters, and the
        JSON schema of its request body. Also returns its access (read, write, or unavailable with the
        reason) and the body fields the API tools refuse to set.${findOperation}

        USAGE:
        - Use before calling an operation, to pass the right parameters and body.

        USAGE EXAMPLES:
        - user_input: What parameters does the dataset items operation take?
        - user_input: How do I update a webhook through the API?
    `;
}

/**
 * Returns one operation of the published Apify API spec, https://docs.apify.com/api/v2.
 */
export const fetchApifyApiOperation: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.API_OPERATION_FETCH,
    title: 'Fetch Apify API operation',
    description: buildDescription(ALL_TOOLS_PRESENT),
    buildDescription,
    inputSchema: z.toJSONSchema(fetchApifyApiOperationArgs) as ToolInputSchema,
    outputSchema: apifyApiOperationOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(fetchApifyApiOperationArgs)),
    annotations: {
        title: 'Fetch Apify API operation',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const parsed = fetchApifyApiOperationArgs.parse(toolArgs.args);
        const index = await fetchApiOperationIndex();
        const operation = index.get(parsed.operationId);
        if (!operation) {
            return respondUserError(formatOperationNotFoundMessage(parsed.operationId, toolArgs.loadedToolNames));
        }
        const result = {
            operationId: operation.operationId,
            method: operation.method,
            path: operation.path,
            summary: operation.summary,
            description: operation.description,
            access: operation.access,
            ...(operation.unavailableReason && { unavailableReason: operation.unavailableReason }),
            parameters: operation.parameters,
            ...(operation.requestBody && { requestBody: operation.requestBody }),
            refusedBodyFields: operation.refusedBodyFields,
        };
        const summary = `${operation.operationId}: ${operation.method} ${operation.path}, ${operation.access} access.`;
        return respondOk([JSON.stringify(result), summary], { structuredContent: result });
    },
} as const);
