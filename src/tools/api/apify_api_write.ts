import dedent from 'dedent';
import { z } from 'zod';

import { HELPER_TOOLS, MAX_INLINE_BYTES } from '../../const.js';
import type { InternalToolArgs, ToolDescriptionContext, ToolEntry, ToolInputSchema } from '../../types.js';
import { ALL_TOOLS_PRESENT, TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { respondUserError } from '../../utils/mcp.js';
import { apifyApiCallOutputSchema } from '../structured_output_schemas.js';
import {
    API_CALL_DESCRIPTION,
    apiCallArgsShape,
    callApi,
    findPathOperations,
    formatList,
    normalizeApiPath,
    redactApiCallArgs,
} from './apify_api_request.js';
import type { ApiMethod } from './apify_api_spec.js';
import { fetchApiOperationIndex } from './apify_api_spec.js';

const apifyApiWriteArgs = z.object({
    path: apiCallArgsShape.path,
    method: z
        .enum(['POST', 'PUT', 'DELETE'])
        .optional()
        .describe('HTTP method: POST, PUT, or DELETE. Omit it only when the path has one method in the API spec.'),
    query: apiCallArgsShape.query,
    body: z.unknown().optional().describe('The request body: any JSON value, usually an object, sent as JSON.'),
});

function buildDescription({ hasTool }: ToolDescriptionContext): string {
    const findPath = hasTool(HELPER_TOOLS.API_SEARCH) ? `\nFind the path with ${HELPER_TOOLS.API_SEARCH}.` : '';
    const getParameters = hasTool(HELPER_TOOLS.API_DETAILS)
        ? `\nGet the operation's parameters and body schema first with ${HELPER_TOOLS.API_DETAILS} and the method.`
        : '';
    return dedent`
        Send a POST, PUT, or DELETE request to the Apify API at a path, such as /v2/datasets/abc.
        ${API_CALL_DESCRIPTION}${findPath}${getParameters}
        The request is sent once and applies at once. Returns the response body as the API sends it; a body
        over ${MAX_INLINE_BYTES} bytes is not returned.

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
 * The only method of the path in the spec, or why the agent must give one. Only a call without a
 * method needs the spec.
 */
async function inferMethod(path: string): Promise<{ method: ApiMethod } | { error: string }> {
    const index = await fetchApiOperationIndex().catch(() => undefined);
    if (!index) return { error: 'The API spec could not be loaded to choose the method; specify the method.' };
    const operations = findPathOperations(index, normalizeApiPath(path));
    if (operations.length === 0) return { error: 'The path is not in the API spec; specify the method.' };
    if (operations.length > 1) {
        const methods = formatList(
            operations.map((operation) => operation.method),
            'and',
        );
        return { error: `The path matches methods ${methods}; specify which one to call the endpoint with.` };
    }
    return { method: operations[0].method };
}

/**
 * Sends a POST, PUT, or DELETE to a path of the Apify API, https://docs.apify.com/api/v2, as a proxy.
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
        // It starts runs and builds, and creates webhooks that call any URL, like the tools that start runs.
        openWorldHint: true,
    },
    // A body can carry secrets: environment variable values, webhook headers, stored records. So can the
    // webhooks query parameter of a run, whose webhooks carry headers.
    redactArgs: redactApiCallArgs,
    call: async (toolArgs: InternalToolArgs) => {
        const parsed = apifyApiWriteArgs.parse(toolArgs.args);
        const resolved = parsed.method ? { method: parsed.method } : await inferMethod(parsed.path);
        if ('error' in resolved) return respondUserError(resolved.error);
        return callApi({
            client: toolArgs.apifyClient,
            token: toolArgs.apifyToken,
            method: resolved.method,
            path: parsed.path,
            query: parsed.query,
            body: parsed.body,
            signal: toolArgs.signal,
            loadedToolNames: toolArgs.loadedToolNames,
        });
    },
} as const);
