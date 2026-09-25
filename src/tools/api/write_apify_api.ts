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
    validateRequestBody,
} from './apify_api_request.js';
import { API_ACCESS, fetchApiOperationIndex } from './apify_api_spec.js';

const writeApifyApiArgs = z.object({
    ...apiCallArgsShape,
    body: z
        .unknown()
        .optional()
        .describe('The request body, sent as JSON. Required when the operation needs one; omit it otherwise.'),
});

function buildDescription({ hasTool }: ToolDescriptionContext): string {
    const getParameters = hasTool(HELPER_TOOLS.API_OPERATION_FETCH)
        ? `\nGet the operation's parameters and body schema first with ${HELPER_TOOLS.API_OPERATION_FETCH}.`
        : '';
    return dedent`
        Call one Apify API operation with write access (POST or PUT), by its operation ID. The server builds
        the URL from the operation's path and pathParams and adds the API token: never pass a URL or a token.${getParameters}
        The request is sent once and applies at once. Refused: deletions, synchronous runs, spending limits,
        run charging, and body fields that publish an Actor or task, change its pricing or permissions, or
        change who can read a storage. Returns the response body as the API sends it; a body over
        ${MAX_INLINE_BYTES} bytes is not returned.

        USAGE:
        - Use to change something no dedicated tool changes, such as a dataset's name or a webhook.
        - Change only what the user asked for.

        USAGE EXAMPLES:
        - user_input: Rename my dataset to leads-2026
        - user_input: Add a webhook that calls https://example.com/hook when a run of my-actor fails
    `;
}

/**
 * Calls one POST or PUT operation of the published Apify API spec, https://docs.apify.com/api/v2.
 */
export const writeApifyApi: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.API_WRITE,
    title: 'Write Apify API',
    description: buildDescription(ALL_TOOLS_PRESENT),
    buildDescription,
    inputSchema: z.toJSONSchema(writeApifyApiArgs) as ToolInputSchema,
    outputSchema: apifyApiCallOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(writeApifyApiArgs)),
    annotations: {
        title: 'Write Apify API',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
    },
    // A body can carry secrets: environment variable values, webhook headers, stored records.
    redactArgs: (args: Record<string, unknown>) => ('body' in args ? { ...args, body: '[REDACTED]' } : args),
    call: async (toolArgs: InternalToolArgs) => {
        const parsed = writeApifyApiArgs.parse(toolArgs.args);
        const index = await fetchApiOperationIndex();
        const resolved = resolveOperationToCall(index, parsed.operationId, API_ACCESS.WRITE, toolArgs.loadedToolNames);
        if ('error' in resolved) return respondUserError(resolved.error);
        const { operation } = resolved;

        const request = buildRequestPath(operation, parsed.pathParams);
        if ('error' in request) return respondUserError(request.error);
        const inputError = validateQueryParams(operation, parsed.query) ?? validateRequestBody(operation, parsed.body);
        if (inputError) return respondUserError(inputError);

        return callApiOperation(toolArgs.apifyClient, operation, request.path, {
            query: parsed.query,
            body: parsed.body,
            signal: toolArgs.signal,
        });
    },
} as const);
