import Ajv from 'ajv';
import dedent from 'dedent';
import { z } from 'zod';

import { HELPER_TOOLS, MAX_INLINE_BYTES } from '../../const.js';
import type { InternalToolArgs, ToolDescriptionContext, ToolEntry, ToolInputSchema } from '../../types.js';
import { ALL_TOOLS_PRESENT, TOOL_TYPE } from '../../types.js';
import { fixZodSchemaRequired } from '../../utils/ajv.js';
import { respondUserError } from '../../utils/mcp.js';
import { anyJsonValueSchema, apifyApiCallOutputSchema } from '../structured_output_schemas.js';
import { isEndpointBlocked } from './apify_api_blocklist.js';
import { normalizeApiPath } from './apify_api_path.js';
import {
    API_CALL_DESCRIPTION,
    apiCallArgsShape,
    callApi,
    findPathOperations,
    formatList,
    redactApiCallArgs,
} from './apify_api_request.js';
import type { ApiMethod } from './apify_api_spec.js';
import { API_METHODS, fetchApiOperationIndex } from './apify_api_spec.js';

const apifyApiWriteArgs = z.object({
    path: apiCallArgsShape.path,
    method: z
        .enum(['POST', 'PUT', 'PATCH', 'DELETE'])
        .optional()
        .describe(
            'HTTP method: POST, PUT, PATCH, or DELETE. Omit it only when the path has one method in the API spec.',
        ),
    query: apiCallArgsShape.query,
    body: z.unknown().optional().describe('The request body: a JSON object or array, sent as JSON.'),
});

function buildDescription({ hasTool }: ToolDescriptionContext): string {
    const findPath = hasTool(HELPER_TOOLS.API_SEARCH) ? `\nFind the path with ${HELPER_TOOLS.API_SEARCH}.` : '';
    const getParameters = hasTool(HELPER_TOOLS.API_DETAILS)
        ? `\nGet the operation's parameters and body schema first with ${HELPER_TOOLS.API_DETAILS} and the method.`
        : '';
    return dedent`
        Send a POST, PUT, PATCH, or DELETE request to the Apify API at a path, such as /v2/datasets/abc.
        ${API_CALL_DESCRIPTION}${findPath}${getParameters}
        Synchronous runs also outlast the 60-second tool-call timeout, so prefer asynchronous runs.
        The request is sent once and applies at once.
        Returns the parsed response body, JSON with its data wrapper included: integers above 2^53 can
        lose precision. A body over ${MAX_INLINE_BYTES} bytes is not returned.

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
 * The method of a call that omits it: the path's only operation in the spec, when that is a write and
 * the path has no blocked write method; otherwise why the caller must give one. The caller is asked
 * only for the write methods; a GET goes to the read tool.
 */
async function inferWriteMethod(
    path: string,
    loadedToolNames: readonly string[],
): Promise<{ method: Exclude<ApiMethod, 'GET'> } | { error: string }> {
    const index = await fetchApiOperationIndex().catch(() => undefined);
    if (!index) return { error: 'The API spec could not be loaded to choose the method; specify the method.' };
    const operations = findPathOperations(index, normalizeApiPath(path));
    if (operations.length === 0) return { error: 'The path is not in the API spec; specify the method.' };
    const writeMethods = operations
        .map((operation) => operation.method)
        .filter((method): method is Exclude<ApiMethod, 'GET'> => method !== 'GET');
    const readTool = loadedToolNames.includes(HELPER_TOOLS.API_READ) ? `; call it with ${HELPER_TOOLS.API_READ}` : '';
    if (writeMethods.length === 0) {
        return { error: `The path has only the GET method, which this tool does not send${readTool}.` };
    }
    // The index leaves out a blocked operation, so the one operation left may not be the path's only write method.
    const hasBlockedWriteMethod = API_METHODS.some(
        (method) => method !== 'GET' && isEndpointBlocked(method, operations[0].path),
    );
    if (operations.length === 1 && !hasBlockedWriteMethod) return { method: writeMethods[0] };
    const getNote = writeMethods.length < operations.length ? ` This tool does not send its GET${readTool}.` : '';
    return { error: `Specify a method for this path: ${formatList(writeMethods, 'or')}.${getNote}` };
}

/**
 * The body to send. A client may send the untyped body as a string of JSON, so a string is parsed to
 * the value it holds; sent as is, it would reach the API as a JSON string.
 */
function parseBody(body: unknown): { value: unknown } | { error: string } {
    if (typeof body !== 'string') return { value: body };
    try {
        return { value: JSON.parse(body) };
    } catch {
        return { error: 'The body is a string that is not valid JSON; give it as a JSON object or array.' };
    }
}

/**
 * Sends a POST, PUT, PATCH, or DELETE to a path of the Apify API, https://docs.apify.com/api/v2, as a proxy.
 */
export const apifyApiWrite: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.API_WRITE,
    title: 'Write Apify API',
    description: buildDescription(ALL_TOOLS_PRESENT),
    buildDescription,
    // Advertise explicit JSON types without letting AJV coerce the body before parseBody() (#1546).
    inputSchema: z.toJSONSchema(
        apifyApiWriteArgs.extend({ body: apifyApiWriteArgs.shape.body.meta(anyJsonValueSchema) }),
    ) as ToolInputSchema,
    outputSchema: apifyApiCallOutputSchema,
    // The shared validator coerces null and singleton arrays into scalar query values.
    ajvValidate: new Ajv({ coerceTypes: false, strict: false, removeAdditional: true }).compile(
        fixZodSchemaRequired(z.toJSONSchema(apifyApiWriteArgs)),
    ),
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
        const body = parseBody(parsed.body);
        if ('error' in body) return respondUserError(body.error);
        const resolved = parsed.method
            ? { method: parsed.method }
            : await inferWriteMethod(parsed.path, toolArgs.loadedToolNames);
        if ('error' in resolved) return respondUserError(resolved.error);
        return callApi({
            client: toolArgs.apifyClient,
            token: toolArgs.apifyToken,
            method: resolved.method,
            path: parsed.path,
            query: parsed.query,
            body: body.value,
            signal: toolArgs.signal,
            loadedToolNames: toolArgs.loadedToolNames,
        });
    },
} as const);
