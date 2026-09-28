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
    resolveReadOperation,
    validateQueryParams,
} from './apify_api_request.js';
import { fetchApiOperationIndex } from './apify_api_spec.js';

const apifyApiReadArgs = z.object(apiCallArgsShape);

function buildDescription({ hasTool }: ToolDescriptionContext): string {
    const findPath = hasTool(HELPER_TOOLS.API_SEARCH) ? `\nFind the path with ${HELPER_TOOLS.API_SEARCH}.` : '';
    const getParameters = hasTool(HELPER_TOOLS.API_DETAILS)
        ? `\nGet the operation's query parameters first with ${HELPER_TOOLS.API_DETAILS} and method GET.`
        : '';
    return dedent`
        Send a GET request to the Apify API at a path with its values in it, such as /v2/actor-runs/abc.
        The server adds the host and the API token: never pass a URL or a token.${findPath}${getParameters}
        Returns the response body as the API sends it, JSON with its data wrapper included; a body over
        ${MAX_INLINE_BYTES} bytes is not returned.

        Example call: {"path": "/v2/datasets/abc/items", "query": {"format": "json", "limit": 10}}

        USAGE:
        - Use for data no dedicated tool returns, such as webhooks, usage, and limits.

        USAGE EXAMPLES:
        - user_input: List the webhooks on my account
        - user_input: How much of my monthly usage have I spent?
    `;
}

/**
 * Sends a GET to a path of the published Apify API spec, https://docs.apify.com/api/v2.
 */
export const apifyApiRead: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.API_READ,
    title: 'Read Apify API',
    description: buildDescription(ALL_TOOLS_PRESENT),
    buildDescription,
    inputSchema: z.toJSONSchema(apifyApiReadArgs) as ToolInputSchema,
    outputSchema: apifyApiCallOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(apifyApiReadArgs)),
    annotations: {
        title: 'Read Apify API',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    // A storage signature, or the webhooks of a synchronous run, would otherwise be logged.
    redactArgs: redactApiCallArgs,
    call: async (toolArgs: InternalToolArgs) => {
        const parsed = apifyApiReadArgs.parse(toolArgs.args);
        const index = await fetchApiOperationIndex();
        const matched = resolvePathOperations({
            index,
            path: parsed.path,
            loadedToolNames: toolArgs.loadedToolNames,
        });
        if ('error' in matched) return respondUserError(matched.error);
        const resolved = resolveReadOperation(matched.path, matched.operations, toolArgs.loadedToolNames);
        if ('error' in resolved) return respondUserError(resolved.error);
        const { operation } = resolved;

        const queryError = validateQueryParams(operation, parsed.query);
        if (queryError) return respondUserError(queryError);

        return callApiOperation({
            client: toolArgs.apifyClient,
            operation,
            path: matched.path,
            query: parsed.query,
            signal: toolArgs.signal,
            loadedToolNames: toolArgs.loadedToolNames,
        });
    },
} as const);
