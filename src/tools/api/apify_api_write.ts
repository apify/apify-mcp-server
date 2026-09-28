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
    callApiOperation,
    redactApiCallArgs,
    resolvePathOperations,
    resolveWriteOperation,
    validateQueryParams,
    validateRequestBody,
} from './apify_api_request.js';
import { API_METHODS, fetchApiOperationIndex } from './apify_api_spec.js';

const apifyApiWriteArgs = z.object({
    path: apiCallArgsShape.path,
    method: z
        .enum(API_METHODS)
        .optional()
        .describe(
            'HTTP method: POST or PUT. Required when the path has several methods, for example GET, PUT, and ' +
                'DELETE; omit it when the path has one.',
        ),
    query: apiCallArgsShape.query,
    body: z
        .unknown()
        .optional()
        .describe(
            'The request body as a JSON object or array, not a JSON-encoded string. It is sent as JSON. ' +
                'Required when the operation needs one; omit it otherwise.',
        ),
});

function buildDescription({ hasTool }: ToolDescriptionContext): string {
    const findPath = hasTool(HELPER_TOOLS.API_SEARCH) ? `\nFind the path with ${HELPER_TOOLS.API_SEARCH}.` : '';
    const getParameters = hasTool(HELPER_TOOLS.API_DETAILS)
        ? `\nGet the operation's parameters and body schema first with ${HELPER_TOOLS.API_DETAILS}.`
        : '';
    return dedent`
        Send a POST or PUT request to the Apify API at a path with its values in it, such as
        /v2/datasets/abc. Give the method when the path has several. The server adds the host and the API
        token: never pass a URL or a token.${findPath}${getParameters}
        The request is sent once and applies at once. Refused: deletions, synchronous runs, metamorphs,
        spending limits, run charging, and creating Actor versions; fields that publish an Actor or task,
        change its pricing or permissions, or change who can read a storage; and fields that set an Actor's
        source, versions, or environment variables, which dedicated source tools or Apify Console change.
        Returns the response body as the API sends it; a body over ${MAX_INLINE_BYTES} bytes is not returned.

        Example call: {"path": "/v2/datasets/abc", "method": "PUT", "body": {"name": "leads-2026"}}

        USAGE:
        - Use to change something no dedicated tool changes, such as a dataset's name or a webhook.
        - Change only what the user asked for.

        USAGE EXAMPLES:
        - user_input: Rename my dataset to leads-2026
        - user_input: Add a webhook that calls https://example.com/hook when a run of my-actor fails
    `;
}

/**
 * Sends a POST or PUT to a path of the published Apify API spec, https://docs.apify.com/api/v2.
 */
export const apifyApiWrite: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.API_WRITE,
    title: 'Write Apify API',
    description: buildDescription(ALL_TOOLS_PRESENT),
    buildDescription,
    inputSchema: z.toJSONSchema(apifyApiWriteArgs) as ToolInputSchema,
    outputSchema: apifyApiCallOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(apifyApiWriteArgs)),
    annotations: {
        title: 'Write Apify API',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
    },
    // A body can carry secrets: environment variable values, webhook headers, stored records. So can the
    // webhooks query parameter of a run, whose webhooks carry headers.
    redactArgs: redactApiCallArgs,
    call: async (toolArgs: InternalToolArgs) => {
        const parsed = apifyApiWriteArgs.parse(toolArgs.args);
        const index = await fetchApiOperationIndex();
        const matched = resolvePathOperations({
            index,
            path: parsed.path,
            loadedToolNames: toolArgs.loadedToolNames,
        });
        if ('error' in matched) return respondUserError(matched.error);
        const resolved = resolveWriteOperation({
            path: matched.path,
            operations: matched.operations,
            method: parsed.method,
            loadedToolNames: toolArgs.loadedToolNames,
        });
        if ('error' in resolved) return respondUserError(resolved.error);
        const { operation } = resolved;

        const inputError = validateQueryParams(operation, parsed.query) ?? validateRequestBody(operation, parsed.body);
        if (inputError) return respondUserError(inputError);

        return callApiOperation({
            client: toolArgs.apifyClient,
            operation,
            path: matched.path,
            query: parsed.query,
            body: parsed.body,
            signal: toolArgs.signal,
        });
    },
} as const);
