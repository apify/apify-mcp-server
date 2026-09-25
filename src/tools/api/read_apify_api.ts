import dedent from 'dedent';
import { z } from 'zod';

import { HELPER_TOOLS, MAX_INLINE_BYTES } from '../../const.js';
import type { InternalToolArgs, ToolDescriptionContext, ToolEntry, ToolInputSchema } from '../../types.js';
import { ALL_TOOLS_PRESENT, TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { respondUserError } from '../../utils/mcp.js';
import { apifyApiCallOutputSchema } from '../structured_output_schemas.js';
import {
    apiCallArgsShape,
    buildRequestPath,
    callApiOperation,
    resolveOperationToCall,
    validateQueryParams,
} from './apify_api_request.js';
import { API_ACCESS, fetchApiOperationIndex } from './apify_api_spec.js';

const readApifyApiArgs = z.object(apiCallArgsShape);

function buildDescription({ hasTool }: ToolDescriptionContext): string {
    const getParameters = hasTool(HELPER_TOOLS.API_OPERATION_FETCH)
        ? `\nGet the operation's parameters first with ${HELPER_TOOLS.API_OPERATION_FETCH}.`
        : '';
    return dedent`
        Call one Apify API operation with read access (GET), by its operation ID. The server builds the
        URL from the operation's path and pathParams and adds the API token: never pass a URL or a token.${getParameters}
        Returns the response body as the API sends it, JSON with its data wrapper included; a body over
        ${MAX_INLINE_BYTES} bytes is not returned.

        USAGE:
        - Use for data no dedicated tool returns, such as webhooks, usage and limits.

        USAGE EXAMPLES:
        - user_input: List the webhooks on my account
        - user_input: How much of my monthly usage have I spent?
    `;
}

/**
 * Calls one GET operation of the published Apify API spec, https://docs.apify.com/api/v2.
 */
export const readApifyApi: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.API_READ,
    title: 'Read Apify API',
    description: buildDescription(ALL_TOOLS_PRESENT),
    buildDescription,
    inputSchema: z.toJSONSchema(readApifyApiArgs) as ToolInputSchema,
    outputSchema: apifyApiCallOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(readApifyApiArgs)),
    annotations: {
        title: 'Read Apify API',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const parsed = readApifyApiArgs.parse(toolArgs.args);
        const index = await fetchApiOperationIndex();
        const resolved = resolveOperationToCall(index, parsed.operationId, API_ACCESS.READ, toolArgs.loadedToolNames);
        if ('error' in resolved) return respondUserError(resolved.error);
        const { operation } = resolved;

        const request = buildRequestPath(operation, parsed.pathParams);
        if ('error' in request) return respondUserError(request.error);
        const queryError = validateQueryParams(operation, parsed.query);
        if (queryError) return respondUserError(queryError);

        return callApiOperation(toolArgs.apifyClient, operation, request.path, {
            query: parsed.query,
            signal: toolArgs.signal,
        });
    },
} as const);
