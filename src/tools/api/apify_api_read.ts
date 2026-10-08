import dedent from 'dedent';
import { z } from 'zod';

import { HELPER_TOOLS, MAX_INLINE_BYTES } from '../../const.js';
import type { InternalToolArgs, ToolDescriptionContext, ToolEntry, ToolInputSchema } from '../../types.js';
import { ALL_TOOLS_PRESENT, TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { apifyApiCallOutputSchema } from '../structured_output_schemas.js';
import { API_CALL_DESCRIPTION, apiCallArgsShape, callApi, redactApiCallArgs } from './apify_api_request.js';

const apifyApiReadArgs = z.object(apiCallArgsShape);

function buildDescription({ hasTool }: ToolDescriptionContext): string {
    const findPath = hasTool(HELPER_TOOLS.API_SEARCH) ? `\nFind the path with ${HELPER_TOOLS.API_SEARCH}.` : '';
    const getParameters = hasTool(HELPER_TOOLS.API_DETAILS)
        ? `\nGet the operation's query parameters first with ${HELPER_TOOLS.API_DETAILS} and method GET.`
        : '';
    const runActor = hasTool(HELPER_TOOLS.ACTOR_CALL) ? ` Run an Actor with ${HELPER_TOOLS.ACTOR_CALL}.` : '';
    return dedent`
        Send a GET request to the Apify API at a path, such as /v2/actor-runs/abc.${runActor}
        ${API_CALL_DESCRIPTION}${findPath}${getParameters}
        Returns the response body as the API sends it, JSON with its data wrapper included; a body over
        ${MAX_INLINE_BYTES} bytes is not returned.

        Example call: {"path": "/v2/webhook-dispatches", "query": {"limit": 10, "desc": true}}

        USAGE:
        - Use for data no dedicated tool returns, such as webhooks, usage, and limits.

        USAGE EXAMPLES:
        - user_input: List the webhooks on my account
        - user_input: How much of my monthly usage have I spent?
    `;
}

/**
 * Sends a GET to a path of the Apify API, https://docs.apify.com/api/v2, as a proxy.
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
        // The blocklist refuses the GETs that would write or start a run: the method query parameter and the
        // synchronous run endpoints.
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    // A storage signature would otherwise be logged.
    redactArgs: redactApiCallArgs,
    call: async (toolArgs: InternalToolArgs) => {
        const parsed = apifyApiReadArgs.parse(toolArgs.args);
        return callApi({
            client: toolArgs.apifyClient,
            token: toolArgs.apifyToken,
            method: 'GET',
            path: parsed.path,
            query: parsed.query,
            signal: toolArgs.signal,
            loadedToolNames: toolArgs.loadedToolNames,
        });
    },
} as const);
