import Ajv from 'ajv';
import type { AxiosResponse } from 'axios';
import dedent from 'dedent';
import { z } from 'zod';

import type { ApifyClient } from '../../apify_client.js';
import { readBodyUnderCap, sendApifyApiRequest } from '../../apify_client.js';
import {
    FAILURE_CATEGORY,
    HELPER_TOOLS,
    HTTP_FORBIDDEN,
    HTTP_UNAUTHORIZED,
    MAX_INLINE_BYTES,
    SERVER_ACTOR_REQUEST_METHODS,
} from '../../const.js';
import { getActorMCPServerPath, resolveOnStandbyOrigin } from '../../mcp/actors.js';
import { EXTERNAL_TOOL_CALL_TIMEOUT_MSEC } from '../../mcp/const.js';
import { isTextualMimeType, maskSessionToken, parseCharset, REDACTED } from '../../resources/api_resources.js';
import type {
    Actor,
    ActorInterfaces,
    ActorTenancy,
    InternalToolArgs,
    ToolDescriptionContext,
    ToolEntry,
    ToolInputSchema,
} from '../../types.js';
import { ALL_TOOLS_PRESENT, TOOL_TYPE } from '../../types.js';
import { getActorDefinitionCached } from '../../utils/actor.js';
import { fixZodSchemaRequired } from '../../utils/ajv.js';
import { toPlainError } from '../../utils/logging.js';
import type { ToolResponse } from '../../utils/mcp.js';
import { respondAborted, respondOk, respondServerError, respondUserError } from '../../utils/mcp.js';
import { resolveActorInterfaces, resolveActorTenancy } from '../actor_tool_naming.js';
import { apiCallArgsShape, redactApiCallArgs } from '../api/apify_api_request.js';
import { parseBaseMimeType } from '../storage/storage_helpers.js';
import { anyJsonValueSchema, serverActorRequestOutputSchema } from '../structured_output_schemas.js';
import { fixActorNameInputAndLog } from './actor_tools_factory.js';
import { buildActorNotFoundResponse } from './fetch_actor_details.js';

type ServerActorRequestMethod = (typeof SERVER_ACTOR_REQUEST_METHODS)[number];

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
            'The path on the Actor Server, starting with /, such as /search. A query string written into the ' +
                'path is sent too.',
        ),
    query: apiCallArgsShape.query.describe(
        'Query parameters, by name, for example {"limit": 10, "verbose": true}; a boolean is sent as true or ' +
            'false. Added to a query string in the path.',
    ),
    body: z.unknown().optional().describe('The JSON request body, sent as application/json. Not allowed with GET.'),
});
type SendServerActorRequestArgs = z.infer<typeof sendServerActorRequestArgs>;

function buildDescription({ hasTool }: ToolDescriptionContext): string {
    const details = hasTool(HELPER_TOOLS.ACTOR_GET_DETAILS)
        ? ` ${HELPER_TOOLS.ACTOR_GET_DETAILS} with output.serverInterface lists the documented operations.`
        : '';
    return dedent`
        Send one HTTP request to an Actor Server: the HTTP API of a Server Actor, documented in its API schema (OpenAPI) and README.${details}
        Give the method, the path, and optionally query parameters and a JSON body; the Actor Server's host and your Apify API token are added for you.
        Only an Actor with an Actor Server and an API schema takes requests here; the Actor accepts or rejects the method and path.
        A request to a single-tenant Actor Server can start a run of the Actor in your account, kept until its idle timeout; a multi-tenant Actor Server charges per event.
        The request is sent once, with no retries and without following redirects. A JSON, text, or XML response body is returned as text; other content types, and bodies over ${MAX_INLINE_BYTES} bytes, are not returned.

        Example call: {"actor": "apify/web-search", "method": "GET", "path": "/", "query": {"query": "AI news", "maxResults": 5}}

        USAGE:
        - Use when the Actor that fits the user's request has an Actor Server, and its API schema or README names the endpoint for the task.
        - Fits requests for one or a few results returned in the HTTP response. Larger batches depend on the endpoint and the response size and time limits.

        USAGE EXAMPLES:
        - user_input: Search the web for the latest AI news with apify/web-search
        - user_input: Find articles about Apify from the past week with apify/web-search
        - user_input: Get the content of https://example.com with apify/web-fetch
    `;
}

/** The Actor and the request as sent: the fields every response about a sent request starts with. */
type ServerActorRequest = {
    actorId: string;
    actorName: string;
    interface: 'server';
    tenancy: ActorTenancy;
    method: ServerActorRequestMethod;
    /** With its query, the session token masked: the agent can write the token into a query value. */
    path: string;
};

/** What the Actor Server sent back; `body` is absent when it exceeded `MAX_INLINE_BYTES`, where reading stopped. */
type ServerActorResponse = {
    status: number;
    contentType?: string;
    location?: string;
    body?: Buffer;
};

/** The request may have gone out, but its response did not fully arrive; `status` is set when the headers did. */
class IncompleteResponseError extends Error {
    override readonly name = 'IncompleteResponseError';

    constructor(
        message: string,
        public readonly status: number | undefined,
        public readonly isTimeout: boolean,
    ) {
        super(message);
    }
}

function buildNoServerInterfaceText(
    actorName: string,
    interfaces: ActorInterfaces,
    loadedToolNames: readonly string[],
): string {
    const text =
        `Actor '${actorName}' has no Actor Server with an API schema, and this tool sends requests only to ` +
        'such Actors. Its README describes how to use it.';
    if (!loadedToolNames.includes(HELPER_TOOLS.ACTOR_CALL)) return text;
    if (interfaces.mcp) {
        return `${text} Its MCP tools can be called with ${HELPER_TOOLS.ACTOR_CALL} as "${actorName}:toolName".`;
    }
    if (interfaces.input) return `${text} It can be run from an input with ${HELPER_TOOLS.ACTOR_CALL}.`;
    return text;
}

/**
 * The URL of `path` on the Actor's standby origin, with `query` added after a query written into the path, or
 * the error response when the request cannot be sent there.
 */
function buildRequestUrl(
    actor: Pick<Actor, 'standbyUrl'>,
    actorName: string,
    { path, query }: Pick<SendServerActorRequestArgs, 'path' | 'query'>,
): { url: URL } | { error: ToolResponse } {
    const resolved = resolveOnStandbyOrigin(actor, path);
    if (!resolved) {
        return {
            error: respondServerError(`Actor '${actorName}' has no valid Actor Server URL. The request was not sent.`),
        };
    }
    // Unlike the MCP URL, a path with credentials is refused rather than stripped: the agent wrote them.
    const { url, standbyOrigin } = resolved;
    if (!url || url.username || url.password) {
        return {
            error: respondUserError(
                `The path must be a valid path on the Actor Server at ${standbyOrigin}, with no credentials. ` +
                    'The request was not sent.',
            ),
        };
    }
    // Not axios `params`: apify-client's serializer sends a boolean as 1 or 0. Not `url.searchParams`: it would
    // encode the query written into the path again.
    const addedQuery = new URLSearchParams(
        Object.entries(query ?? {}).map(([name, value]): [string, string] => [name, String(value)]),
    ).toString();
    if (addedQuery) url.search = url.search ? `${url.search}&${addedQuery}` : addedQuery;
    return { url };
}

/** A response header's value; `undefined` when it is absent or not a single string. */
function readHeader(headers: AxiosResponse['headers'], name: string): string | undefined {
    const value: unknown = headers[name];
    return typeof value === 'string' ? value : undefined;
}

/**
 * Sends the request once, without following redirects, and reads the body up to `MAX_INLINE_BYTES`. The deadline
 * covers reading the body too. Any failure is thrown as an `IncompleteResponseError`: even a connection that drops
 * before the status may have delivered the request.
 */
async function sendRequest({
    client,
    url,
    method,
    body,
    signal,
    timeoutMillis,
}: {
    client: ApifyClient;
    url: URL;
    method: ServerActorRequestMethod;
    body: unknown;
    signal: AbortSignal;
    timeoutMillis: number;
}): Promise<ServerActorResponse> {
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
        return {
            status,
            contentType: readHeader(response.headers, 'content-type'),
            location: readHeader(response.headers, 'location'),
            body: await readBodyUnderCap(response),
        };
    } catch (error) {
        throw new IncompleteResponseError(toPlainError(error).message, status, deadline.aborted);
    }
}

/**
 * The body decoded with `charset`, the session token masked before and after decoding; `undefined` when
 * `TextDecoder` does not support the charset.
 */
function decodeBody(body: Buffer, charset: string, token: string): string | undefined {
    try {
        return new TextDecoder(charset).decode(maskSessionToken(body, token)).replaceAll(token, REDACTED);
    } catch {
        return undefined;
    }
}

/**
 * The `error` string of a JSON `{"error": ...}` body; `undefined` for any other body, which the response already
 * carries as `body`.
 */
function getReadableErrorMessage(body: string, token: string): string | undefined {
    try {
        const parsed = z.object({ error: z.string() }).safeParse(JSON.parse(body));
        // JSON escapes can hide the token until parsing.
        if (parsed.success) return parsed.data.error.replaceAll(token, REDACTED);
    } catch {
        // An Actor can return plain text or malformed JSON.
    }
    return undefined;
}

function buildRequestRecoveryText(
    status: number,
    actorName: string,
    loadedToolNames: readonly string[],
    hasErrorMessage: boolean,
): string | undefined {
    if (status === 429) return 'The Actor Server rate limit was reached.';
    if (status === 503) return 'The Actor Server is temporarily unavailable.';
    if (![400, 404, 405, 422].includes(status)) return undefined;
    const documentation = loadedToolNames.includes(HELPER_TOOLS.ACTOR_GET_DETAILS)
        ? `${HELPER_TOOLS.ACTOR_GET_DETAILS} with ${JSON.stringify({ actor: actorName, output: { serverInterface: true } })} lists the documented HTTP operations.`
        : 'The Actor README may describe its HTTP endpoints.';
    return hasErrorMessage
        ? `The Actor Server error may name the expected HTTP method, path, or parameters. ${documentation}`
        : documentation;
}

/** The tool response for what the Actor Server sent back, with the session token masked. */
function buildResponse(
    request: ServerActorRequest,
    response: ServerActorResponse,
    { apifyToken: token, loadedToolNames }: Pick<InternalToolArgs, 'apifyToken' | 'loadedToolNames'>,
): ToolResponse {
    const { status } = response;
    const contentType = response.contentType?.replaceAll(token, REDACTED);
    const location = response.location?.replaceAll(token, REDACTED);
    const outcome = `${request.method} ${request.path} on ${request.actorName} returned HTTP ${status}`;
    const rejectBody = (reason: string) =>
        respondUserError(`${outcome}. The body is not returned: ${reason}. The request itself was sent.`, {
            httpStatus: status,
        });

    if (response.body === undefined) return rejectBody(`it is larger than ${MAX_INLINE_BYTES} bytes`);
    const bytes = response.body.length;
    const mimeType = parseBaseMimeType(contentType);
    if (bytes > 0 && !isTextualMimeType(mimeType)) {
        return rejectBody(
            `it is ${bytes} bytes of ${mimeType ?? 'an unknown type'}, and only JSON, text, and XML bodies are returned`,
        );
    }
    const charset = parseCharset(contentType) ?? 'utf-8';
    const body = bytes === 0 ? '' : decodeBody(response.body, charset, token);
    if (body === undefined) return rejectBody(`its charset "${charset}" is not supported`);

    const bodyNote = bytes === 0 ? 'an empty body' : `${bytes} bytes of ${mimeType}`;
    const redirectNote = location ? ` The redirect to ${location} was not followed.` : '';
    const summary = `${outcome} with ${bodyNote}.${redirectNote}`;
    const errorMessage = status >= 400 && body ? getReadableErrorMessage(body, token) : undefined;
    const nextStep = buildRequestRecoveryText(status, request.actorName, loadedToolNames, errorMessage !== undefined);
    const structuredContent = {
        ...request,
        status,
        ...(contentType && { contentType }),
        body,
        bytes,
        ...(location && { location }),
        summary,
        ...(errorMessage && { errorMessage }),
        ...(nextStep && { nextStep }),
    };
    const texts = [JSON.stringify(structuredContent), summary];
    if (errorMessage) texts.push(`Actor Server error: ${errorMessage}`);
    if (nextStep) texts.push(nextStep);
    if (status < 400) return respondOk(texts, { structuredContent });
    return respondUserError(texts, {
        ...((status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN) && { category: FAILURE_CATEGORY.AUTH }),
        httpStatus: status,
        structuredContent,
    });
}

/** The tool response when the request went out but its response did not fully arrive. */
function buildIncompleteResponse(
    request: ServerActorRequest,
    error: IncompleteResponseError,
    timeoutMillis: number,
): ToolResponse {
    const got =
        error.status === undefined ? 'got no complete response' : `got HTTP ${error.status} but not the whole body`;
    const why = error.isTimeout ? `within ${timeoutMillis / 1000} seconds` : `(${error.message})`;
    return respondServerError(
        `${request.method} ${request.path} on ${request.actorName} ${got} ${why}. Nothing is returned, and the ` +
            'Actor may still have processed the request.',
        { detail: error.isTimeout ? 'timeout' : error.status === undefined ? 'no response' : 'incomplete body' },
    );
}

/** `timeoutMillis` shortens the deadline in local tests; production keeps `EXTERNAL_TOOL_CALL_TIMEOUT_MSEC`. */
export async function executeSendServerActorRequest(
    toolArgs: InternalToolArgs,
    { timeoutMillis = EXTERNAL_TOOL_CALL_TIMEOUT_MSEC }: { timeoutMillis?: number } = {},
): Promise<ToolResponse> {
    const { apifyToken, apifyClient, mcpSessionId, loadedToolNames, signal } = toolArgs;
    const args = sendServerActorRequestArgs.parse(toolArgs.args);
    if (!apifyToken) {
        return respondUserError('An Apify API token is required to send requests to an Actor Server.', {
            category: FAILURE_CATEGORY.AUTH,
        });
    }
    // The path is not echoed: it can carry the session token.
    if (!args.path.startsWith('/')) return respondUserError('The path must start with "/", for example "/search".');
    if (args.method === 'GET' && args.body !== undefined) {
        return respondUserError('A GET request cannot have a body. Send the data in query instead.');
    }

    const actorName = fixActorNameInputAndLog(args.actor, { mcpSessionId, route: HELPER_TOOLS.ACTOR_SERVER_REQUEST });
    const cached = await getActorDefinitionCached(actorName, apifyClient);
    if (!cached) return buildActorNotFoundResponse(actorName, loadedToolNames);
    const { definition, info } = cached;
    const tenancy = resolveActorTenancy(info);
    // Every response from here on names the Actor, and the status once one arrived, in telemetry.
    const withActorTelemetry = (response: ToolResponse, httpStatus?: number): ToolResponse => ({
        ...response,
        toolTelemetry: {
            ...response.toolTelemetry,
            actorId: info.id,
            actorTenancy: tenancy,
            ...(httpStatus !== undefined && { httpStatus }),
        },
    });

    // Not `getActorToolResolutionCached`: it resolves the MCP URL too, and a bad MCP path must not stop an HTTP request.
    const interfaces = resolveActorInterfaces({
        definition,
        actor: info,
        webServerMcpPath: getActorMCPServerPath(definition),
    });
    if (!interfaces.server) {
        return withActorTelemetry(
            respondUserError(buildNoServerInterfaceText(definition.actorFullName, interfaces, loadedToolNames)),
        );
    }
    const target = buildRequestUrl(info, definition.actorFullName, args);
    if ('error' in target) return withActorTelemetry(target.error);

    const { url } = target;
    const request: ServerActorRequest = {
        actorId: info.id,
        actorName: definition.actorFullName,
        interface: 'server',
        tenancy,
        method: args.method,
        path: `${url.pathname}${url.search}`.replaceAll(apifyToken, REDACTED),
    };
    try {
        const response = await sendRequest({
            client: apifyClient,
            url,
            method: args.method,
            body: args.body,
            signal,
            timeoutMillis,
        });
        return withActorTelemetry(buildResponse(request, response, { apifyToken, loadedToolNames }), response.status);
    } catch (error) {
        if (signal.aborted) return respondAborted();
        if (!(error instanceof IncompleteResponseError)) throw error;
        return withActorTelemetry(buildIncompleteResponse(request, error, timeoutMillis), error.status);
    }
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
    // The shared validator coerces null and singleton arrays into scalar query values.
    ajvValidate: new Ajv({ coerceTypes: false, strict: false, removeAdditional: true }).compile(
        fixZodSchemaRequired(z.toJSONSchema(sendServerActorRequestArgs)),
    ),
    // A third-party payment provider cannot pay for an Actor Server run, so such a session is rejected before the call.
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
