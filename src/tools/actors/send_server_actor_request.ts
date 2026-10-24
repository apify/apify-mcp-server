import dedent from 'dedent';
import { z } from 'zod';

import type { ApifyClient } from '../../apify_client.js';
import { sendApifyApiRequest } from '../../apify_client.js';
import { FAILURE_CATEGORY, HELPER_TOOLS, HTTP_FORBIDDEN, HTTP_UNAUTHORIZED, MAX_INLINE_BYTES } from '../../const.js';
import { TimeoutError } from '../../errors.js';
import { getActorMCPServerPath, resolveOnStandbyOrigin } from '../../mcp/actors.js';
import { EXTERNAL_TOOL_CALL_TIMEOUT_MSEC } from '../../mcp/const.js';
import {
    collectStream,
    isMaxContentLengthAbort,
    isTextualMimeType,
    maskSessionToken,
    REDACTED,
} from '../../resources/api_resources.js';
import type {
    ActorInterfaces,
    ActorTenancy,
    InternalToolArgs,
    ToolDescriptionContext,
    ToolEntry,
    ToolInputSchema,
    ToolTelemetryContext,
} from '../../types.js';
import { ALL_TOOLS_PRESENT, TOOL_TYPE } from '../../types.js';
import { getActorDefinitionCached } from '../../utils/actor.js';
import { compileSchema } from '../../utils/ajv.js';
import { toPlainError } from '../../utils/logging.js';
import type { ToolResponse } from '../../utils/mcp.js';
import { respondAborted, respondOk, respondServerError, respondUserError } from '../../utils/mcp.js';
import { resolveActorInterfaces, resolveActorTenancy } from '../actor_tool_naming.js';
import { apiCallArgsShape, redactApiCallArgs } from '../api/apify_api_request.js';
import { parseBaseMimeType } from '../storage/storage_helpers.js';
import { anyJsonValueSchema, serverActorRequestOutputSchema } from '../structured_output_schemas.js';
import { fixActorNameInputAndLog } from './actor_tools_factory.js';
import { buildActorNotFoundResponse } from './fetch_actor_details.js';

const SERVER_ACTOR_REQUEST_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type ServerActorRequestMethod = (typeof SERVER_ACTOR_REQUEST_METHODS)[number];

const sendServerActorRequestArgs = z.object({
    actor: z
        .string()
        .min(1)
        .describe('The Actor: its ID, or its name in the "username/name" form, such as "apify/web-fetch".'),
    method: z
        .enum(SERVER_ACTOR_REQUEST_METHODS)
        .describe('HTTP method: GET, POST, PUT, PATCH, or DELETE. The Actor accepts or rejects it.'),
    path: z
        .string()
        .min(1)
        .describe(
            "The path on the Actor's server, starting with /, such as /search. A query string written into the " +
                'path is sent too.',
        ),
    query: apiCallArgsShape.query.describe(
        'Query parameters, by name, for example {"limit": 10, "verbose": true}; a boolean is sent as true or ' +
            'false. Added to a query string in the path.',
    ),
    body: z.unknown().optional().describe('The JSON request body, sent as application/json. Not allowed with GET.'),
});

function buildDescription({ hasTool }: ToolDescriptionContext): string {
    const callActor = hasTool(HELPER_TOOLS.ACTOR_CALL)
        ? ` Unlike ${HELPER_TOOLS.ACTOR_CALL}, it starts no run from an input; an Actor can have both interfaces.`
        : '';
    return dedent`
        Send one HTTP request to a Server Actor's API: the server interface its API schema (OpenAPI) and README document.${callActor}
        The server adds the host and the Apify API token; give the method, the path, and optionally query parameters and a JSON body.
        Only an Actor with Actor Standby enabled and an API schema takes requests here, and the Actor itself accepts or rejects the method and path.
        A request can start a standby run of the Actor in your account, kept for its idle timeout, or is charged per event when the Actor is multi-tenant.
        The request is sent once, with no retries and without following redirects. The response body comes back as text (JSON, text, or XML); a body over ${MAX_INLINE_BYTES} bytes is not returned.

        Example call: {"actor": "username/name", "method": "POST", "path": "/search", "body": {"query": "apify"}}

        USAGE:
        - Use when the user asks for an Actor's HTTP endpoint, or the Actor's documentation names one.

        USAGE EXAMPLES:
        - user_input: Send GET /status to username/name
    `;
}

/** What one request got back; `body` is absent when it exceeded `MAX_INLINE_BYTES`, where reading stopped. */
export type ServerActorResponse = {
    status: number;
    contentType?: string;
    location?: string;
    body?: Buffer;
};

/**
 * Sends one request to a URL on an Actor's standby origin, which the caller has checked, through
 * `sendApifyApiRequest`: the session token and the request-origin header go along, there are no retries,
 * redirects are not followed, and the body is read as raw bytes, capped at `MAX_INLINE_BYTES` after
 * decompression. The deadline covers reading the body; when it passes before the client cancels, a
 * `TimeoutError` is thrown, with the `status` when one arrived.
 */
export async function fetchServerActorResponse(params: {
    client: ApifyClient;
    url: URL;
    method: ServerActorRequestMethod;
    body?: unknown;
    signal: AbortSignal;
    timeoutMillis: number;
}): Promise<ServerActorResponse> {
    const { client, url, method, body, signal, timeoutMillis } = params;
    const deadline = AbortSignal.timeout(timeoutMillis);
    let status: number | undefined;
    try {
        const response = await sendApifyApiRequest(client, {
            url: url.href,
            method,
            // Bytes, not a string: apify-client compresses a string body of 1 KiB or more with brotli, which
            // an Actor's server need not decode.
            ...(body !== undefined && {
                data: new TextEncoder().encode(JSON.stringify(body)),
                headers: { 'Content-Type': 'application/json' },
            }),
            responseType: 'stream',
            maxRedirects: 0,
            signal: AbortSignal.any([signal, deadline]),
        });
        status = response.status;
        const header = (name: string): string | undefined => {
            const value: unknown = response.headers[name];
            return typeof value === 'string' ? value : undefined;
        };
        const result = { status, contentType: header('content-type'), location: header('location') };
        try {
            return { ...result, body: await collectStream(response.data) };
        } catch (error) {
            if (isMaxContentLengthAbort(error)) return result;
            throw error;
        }
    } catch (error) {
        if (deadline.aborted && !signal.aborted) {
            throw Object.assign(
                new TimeoutError(`The Actor server did not finish responding within ${timeoutMillis} ms`),
                { status },
            );
        }
        throw error;
    }
}

/** The response with the Actor fields, and the status once one arrived, for the response telemetry. */
function withServerActorTelemetry(response: ToolResponse, telemetry: ToolTelemetryContext): ToolResponse {
    return { ...response, toolTelemetry: { ...response.toolTelemetry, ...telemetry } };
}

function buildNoServerInterfaceText(
    actorName: string,
    interfaces: ActorInterfaces,
    loadedToolNames: readonly string[],
): string {
    const text =
        `Actor '${actorName}' has no HTTP API documented by an API schema, so this tool cannot send it a ` +
        'request. See its README for how to use it.';
    if (!loadedToolNames.includes(HELPER_TOOLS.ACTOR_CALL)) return text;
    if (interfaces.mcp) {
        return `${text} Its MCP tools are called with ${HELPER_TOOLS.ACTOR_CALL} as "${actorName}:toolName".`;
    }
    if (interfaces.input) return `${text} It runs from an input with ${HELPER_TOOLS.ACTOR_CALL}.`;
    return text;
}

function buildResponse(params: {
    response: ServerActorResponse;
    method: ServerActorRequestMethod;
    path: string;
    actorId: string;
    actorName: string;
    tenancy: ActorTenancy;
    /** The session's token, masked in the body and the location. */
    token: string;
}): ToolResponse {
    const { response, method, path, actorId, actorName, tenancy, token } = params;
    const { status, contentType } = response;
    const location = response.location?.replaceAll(token, REDACTED);
    const outcome = `${method} ${path} on ${actorName} returned HTTP ${status}`;
    if (response.body === undefined) {
        return respondUserError(
            `${outcome} with a body larger than ${MAX_INLINE_BYTES} bytes, so the body is not returned. ` +
                'The request itself was sent.',
            { httpStatus: status },
        );
    }
    const bytes = response.body.length;
    const baseMimeType = parseBaseMimeType(contentType);
    if (bytes > 0 && !isTextualMimeType(baseMimeType)) {
        return respondUserError(
            `${outcome} with ${bytes} bytes of ${baseMimeType ?? 'an unknown type'}, which this tool does not ` +
                'return; it returns JSON, text, and XML bodies. The request itself was sent.',
            { httpStatus: status },
        );
    }
    const structuredContent = {
        actorId,
        actorName,
        interface: 'server',
        tenancy,
        method,
        path,
        status,
        ...(contentType && { contentType }),
        body: maskSessionToken(response.body, token).toString('utf8'),
        bytes,
        ...(location && { location }),
    };
    const bodyNote = bytes === 0 ? 'an empty body' : `${bytes} bytes of ${baseMimeType}`;
    const redirectNote = location ? `, redirecting to ${location}, which is not followed` : '';
    const texts = [JSON.stringify(structuredContent), `${outcome} with ${bodyNote}${redirectNote}.`];
    if (status < 400) return respondOk(texts, { structuredContent });
    if (status === 429 || status === 503) {
        texts.push('The Actor server is busy; wait, then send requests one at a time.');
    }
    return respondUserError(texts, {
        ...((status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN) && { category: FAILURE_CATEGORY.AUTH }),
        httpStatus: status,
        structuredContent,
    });
}

/** `timeoutMillis` shortens the deadline in local tests; production keeps `EXTERNAL_TOOL_CALL_TIMEOUT_MSEC`. */
export async function executeSendServerActorRequest(
    toolArgs: InternalToolArgs,
    { timeoutMillis = EXTERNAL_TOOL_CALL_TIMEOUT_MSEC }: { timeoutMillis?: number } = {},
): Promise<ToolResponse> {
    const { apifyToken, apifyClient, mcpSessionId, loadedToolNames, signal } = toolArgs;
    const parsed = sendServerActorRequestArgs.parse(toolArgs.args);
    if (!apifyToken) {
        return respondUserError('An Apify API token is required: the request to the Actor server carries it.', {
            category: FAILURE_CATEGORY.AUTH,
        });
    }
    if (!parsed.path.startsWith('/')) {
        return respondUserError(`The path must start with /, as in /search; "${parsed.path}" does not.`);
    }
    if (parsed.method === 'GET' && parsed.body !== undefined) {
        return respondUserError('A GET request carries no body; leave body out, or send the data as query parameters.');
    }

    const actorName = fixActorNameInputAndLog(parsed.actor, { mcpSessionId, route: HELPER_TOOLS.ACTOR_SERVER_REQUEST });
    const cached = await getActorDefinitionCached(actorName, apifyClient);
    if (!cached) return buildActorNotFoundResponse(actorName, loadedToolNames);
    const { definition, info } = cached;
    const { actorFullName } = definition;
    const tenancy = resolveActorTenancy(info);
    const telemetry: ToolTelemetryContext = { actorId: info.id, actorTenancy: tenancy };

    // Not `getActorToolResolutionCached`: it resolves the MCP URL too, and a bad MCP path must not stop an HTTP request.
    const interfaces = resolveActorInterfaces({
        definition,
        actor: info,
        webServerMcpPath: getActorMCPServerPath(definition),
    });
    if (!interfaces.server) {
        return withServerActorTelemetry(
            respondUserError(buildNoServerInterfaceText(actorFullName, interfaces, loadedToolNames)),
            telemetry,
        );
    }
    const resolved = resolveOnStandbyOrigin(info, parsed.path);
    if (!resolved) {
        return withServerActorTelemetry(
            respondServerError(
                `Actor '${actorFullName}' has no valid standby URL in its Actor Standby configuration, so its ` +
                    'server cannot be reached.',
            ),
            telemetry,
        );
    }
    // Unlike the MCP URL, a path with credentials is refused rather than stripped: the agent wrote them.
    const { url, standbyOrigin } = resolved;
    if (!url || url.username || url.password) {
        return withServerActorTelemetry(
            respondUserError(
                `The path "${parsed.path}" leaves the Actor's server at ${standbyOrigin}, so it is not sent.`,
            ),
            telemetry,
        );
    }
    // Not axios `params`: apify-client's serializer sends a boolean as 1 or 0. Not `url.searchParams`: it would
    // encode the query written into the path again.
    const query = new URLSearchParams(
        Object.entries(parsed.query ?? {}).map(([name, value]) => [name, String(value)]),
    ).toString();
    if (query) url.search = url.search ? `${url.search}&${query}` : query;
    const path = `${url.pathname}${url.search}`;

    let response: ServerActorResponse;
    try {
        response = await fetchServerActorResponse({
            client: apifyClient,
            url,
            method: parsed.method,
            body: parsed.body,
            signal,
            timeoutMillis,
        });
    } catch (error) {
        if (signal.aborted) return respondAborted();
        if (error instanceof TimeoutError) {
            const { status } = error as TimeoutError & { status?: number };
            const outcome =
                status === undefined ? 'got no complete response' : `got HTTP ${status} but not the whole body`;
            return withServerActorTelemetry(
                respondServerError(
                    `${parsed.method} ${path} on ${actorFullName} ${outcome} within ${timeoutMillis / 1000} ` +
                        'seconds, so nothing is returned. The Actor may still have processed the request.',
                    { detail: 'timeout' },
                ),
                { ...telemetry, ...(status !== undefined && { httpStatus: status }) },
            );
        }
        throw toPlainError(error);
    }
    return withServerActorTelemetry(
        buildResponse({
            response,
            method: parsed.method,
            path,
            actorId: info.id,
            actorName: actorFullName,
            tenancy,
            token: apifyToken,
        }),
        { ...telemetry, httpStatus: response.status },
    );
}

/** Sends one HTTP request to a Server Actor's API, the server interface its `webServerSchema` documents. */
export const sendServerActorRequest: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_SERVER_REQUEST,
    title: 'Send Server Actor request',
    description: buildDescription(ALL_TOOLS_PRESENT),
    buildDescription,
    // Advertise explicit JSON types without letting AJV coerce the body, as apify-api-write does.
    inputSchema: z.toJSONSchema(
        sendServerActorRequestArgs.extend({ body: sendServerActorRequestArgs.shape.body.meta(anyJsonValueSchema) }),
    ) as ToolInputSchema,
    outputSchema: serverActorRequestOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(sendServerActorRequestArgs)),
    // A third-party payment provider cannot pay for a standby run, so such a session is rejected before the call.
    hasPaymentProviderStandbyCheck: true,
    annotations: {
        title: 'Send Server Actor request',
        readOnlyHint: false,
        // The agent can send DELETE, PUT, or PATCH to third-party code.
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
    },
    // The body can carry secrets, and a query value can be a token.
    redactArgs: ({ actor, ...rest }: Record<string, unknown>) => ({ actor, ...redactApiCallArgs(rest) }),
    call: async (toolArgs: InternalToolArgs) => executeSendServerActorRequest(toolArgs),
} as const);
