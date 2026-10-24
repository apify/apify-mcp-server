import Ajv from 'ajv';
import type { AxiosResponse } from 'axios';
import dedent from 'dedent';
import { z } from 'zod';

import type { ApifyClient } from '../../apify_client.js';
import { readBodyUnderCap, sendApifyApiRequest } from '../../apify_client.js';
import { FAILURE_CATEGORY, HELPER_TOOLS, HTTP_FORBIDDEN, HTTP_UNAUTHORIZED, MAX_INLINE_BYTES } from '../../const.js';
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

const SERVER_ACTOR_REQUEST_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
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
    const callActor = hasTool(HELPER_TOOLS.ACTOR_CALL)
        ? ` Unlike ${HELPER_TOOLS.ACTOR_CALL}, it starts no run from an input; an Actor can have both interfaces.`
        : '';
    return dedent`
        Send one HTTP request to an Actor Server: the HTTP API of a Server Actor, documented in its API schema (OpenAPI) and README.${callActor}
        Give the method, the path, and optionally query parameters and a JSON body; the Actor Server's host and your Apify API token are added for you.
        Only an Actor with an Actor Server and an API schema takes requests here; the Actor accepts or rejects the method and path.
        A request to a single-tenant Actor Server can start a run of the Actor in your account, kept until its idle timeout; a multi-tenant Actor Server charges per event.
        The request is sent once, with no retries and without following redirects. A JSON, text, or XML response body is returned as text; other content types, and bodies over ${MAX_INLINE_BYTES} bytes, are not returned.

        Example call: {"actor": "username/name", "method": "POST", "path": "/search", "body": {"query": "apify"}}

        USAGE:
        - Use when the user asks for an Actor Server HTTP endpoint, or the Actor's documentation names one.

        USAGE EXAMPLES:
        - user_input: Send GET /status to username/name
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

/** The request went out, but its response did not fully arrive; `status` is set when the headers did. */
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
        `Actor '${actorName}' has no HTTP API documented by an API schema, so this tool cannot send it a ` +
        'request. See its README for how to use it.';
    if (!loadedToolNames.includes(HELPER_TOOLS.ACTOR_CALL)) return text;
    if (interfaces.mcp) {
        return `${text} Its MCP tools are called with ${HELPER_TOOLS.ACTOR_CALL} as "${actorName}:toolName".`;
    }
    if (interfaces.input) return `${text} It runs from an input with ${HELPER_TOOLS.ACTOR_CALL}.`;
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
            error: respondServerError(
                `Actor '${actorName}' has no valid Actor Server URL, so its Actor Server cannot be reached.`,
            ),
        };
    }
    // Unlike the MCP URL, a path with credentials is refused rather than stripped: the agent wrote them.
    const { url, standbyOrigin } = resolved;
    if (!url || url.username || url.password) {
        return {
            error: respondUserError(`The path leaves the Actor Server at ${standbyOrigin}, so it is not sent.`),
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
 * covers reading the body too. A failure once the status arrived, or the deadline passing, is thrown as an
 * `IncompleteResponseError`; any other failure is thrown as is.
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
        if (!deadline.aborted && status === undefined) throw toPlainError(error);
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

/** The tool response for what the Actor Server sent back, with the session token masked. */
function buildResponse(request: ServerActorRequest, response: ServerActorResponse, token: string): ToolResponse {
    const { status } = response;
    const contentType = response.contentType?.replaceAll(token, REDACTED);
    const location = response.location?.replaceAll(token, REDACTED);
    const outcome = `${request.method} ${request.path} on ${request.actorName} returned HTTP ${status}`;
    const rejectBody = (reason: string) =>
        respondUserError(`${outcome} ${reason} The request itself was sent.`, { httpStatus: status });

    if (response.body === undefined) {
        return rejectBody(`with a body larger than ${MAX_INLINE_BYTES} bytes, so the body is not returned.`);
    }
    const bytes = response.body.length;
    const mimeType = parseBaseMimeType(contentType);
    if (bytes > 0 && !isTextualMimeType(mimeType)) {
        return rejectBody(
            `with ${bytes} bytes of ${mimeType ?? 'an unknown type'}, which this tool does not return; it ` +
                'returns JSON, text, and XML bodies.',
        );
    }
    const charset = parseCharset(contentType) ?? 'utf-8';
    const body = bytes === 0 ? '' : decodeBody(response.body, charset, token);
    if (body === undefined) return rejectBody(`with unsupported charset "${charset}", so the body is not returned.`);

    const structuredContent = {
        ...request,
        status,
        ...(contentType && { contentType }),
        body,
        bytes,
        ...(location && { location }),
    };
    const bodyNote = bytes === 0 ? 'an empty body' : `${bytes} bytes of ${mimeType}`;
    const redirectNote = location ? `, redirecting to ${location}, which is not followed` : '';
    const texts = [JSON.stringify(structuredContent), `${outcome} with ${bodyNote}${redirectNote}.`];
    if (status < 400) return respondOk(texts, { structuredContent });
    if (status === 429 || status === 503) {
        texts.push('The Actor Server is busy; wait, then send requests one at a time.');
    }
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
        `${request.method} ${request.path} on ${request.actorName} ${got} ${why}, so nothing is returned. ` +
            'The Actor may still have processed the request.',
        { detail: error.isTimeout ? 'timeout' : 'incomplete body' },
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
        return respondUserError('An Apify API token is required: the request to the Actor Server carries it.', {
            category: FAILURE_CATEGORY.AUTH,
        });
    }
    if (!args.path.startsWith('/')) return respondUserError('The path must start with /, as in /search.');
    if (args.method === 'GET' && args.body !== undefined) {
        return respondUserError('A GET request carries no body; leave body out, or send the data as query parameters.');
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
        return withActorTelemetry(buildResponse(request, response, apifyToken), response.status);
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
