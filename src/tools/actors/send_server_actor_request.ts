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
    ServerActorToolInfo,
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
import { API_METHODS, type ApiMethod, isRecord } from '../api/apify_api_spec.js';
import { parseBaseMimeType } from '../storage/storage_helpers.js';
import { anyJsonValueSchema, serverActorRequestOutputSchema } from '../structured_output_schemas.js';
import { fixActorNameInputAndLog } from './actor_tools_factory.js';
import { buildActorNotFoundResponse } from './fetch_actor_details.js';

const sendServerActorRequestArgs = z.object({
    actor: z
        .string()
        .min(1)
        .describe('The Actor: its ID, or its name in the "username/name" form, such as "apify/web-fetch".'),
    method: z
        .enum(API_METHODS)
        .describe('HTTP method: GET, POST, PUT, PATCH, or DELETE. The Actor accepts or rejects it.'),
    path: z.string().min(1).describe(dedent`
            The path of an operation in the Actor API schema, starting with /. Take it from the schema; do not guess it.
            A query string written into the path is sent too.
        `),
    query: apiCallArgsShape.query.describe(
        'Query parameters, by name, for example {"limit": 10, "verbose": true}; a boolean is sent as true or ' +
            'false. Added to a query string in the path.',
    ),
    body: z.unknown().optional().describe('The JSON request body, sent as application/json. Not allowed with GET.'),
});
type SendServerActorRequestArgs = z.infer<typeof sendServerActorRequestArgs>;

/** Advertises explicit JSON types for `body` without letting AJV coerce it, as apify-api-write does. */
function toAdvertisedInputSchema(args: z.ZodObject<z.ZodRawShape>): ToolInputSchema {
    const { body } = args.shape;
    const advertised = body ? args.extend({ body: (body as z.ZodType).meta(anyJsonValueSchema) }) : args;
    return z.toJSONSchema(advertised) as ToolInputSchema;
}

/**
 * The input schema and validator of a selected Server Actor's tool: this tool's arguments without `actor`, `method`
 * and `path` narrowed to the documented ones, each with a default when there is one, and `body` only when an
 * operation takes one. A templated path cannot be an enum, so then `path` is a string that lists the paths.
 */
export function buildServerActorToolSchemas({
    methods,
    paths,
    hasRequestBody,
}: Pick<ServerActorToolInfo, 'methods' | 'paths' | 'hasRequestBody'>) {
    const method = z.enum(methods).describe('HTTP method of the operation.');
    const isTemplated = paths.some((path) => /\{[^}]*\}/.test(path));
    const path = isTemplated
        ? z
              .string()
              .min(1)
              .describe(`The path of an operation: ${paths.join(', ')}. Replace each {name} with its value.`)
        : z.enum(paths).describe('The path of an operation.');
    const args = z.object({
        method: methods.length === 1 ? method.default(methods[0]) : method,
        path: paths.length === 1 && !isTemplated ? path.default(paths[0]) : path,
        query: sendServerActorRequestArgs.shape.query,
        ...(hasRequestBody && { body: sendServerActorRequestArgs.shape.body }),
    });
    return {
        inputSchema: toAdvertisedInputSchema(args),
        // `useDefaults` fills a defaulted method or path before the request is built from the arguments.
        ajvValidate: new Ajv({ coerceTypes: false, strict: false, removeAdditional: true, useDefaults: true }).compile(
            fixZodSchemaRequired(z.toJSONSchema(args)),
        ),
    };
}

/** The Actor and the request as sent: the fields every response about a sent request starts with. */
type ServerActorRequest = {
    actorId: string;
    actorName: string;
    interface: 'server';
    tenancy: ActorTenancy;
    method: ApiMethod;
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
    if (interfaces.mcp && loadedToolNames.includes(HELPER_TOOLS.ACTOR_MCP_TOOL_CALL)) {
        return `${text} Its MCP tools can be called with ${HELPER_TOOLS.ACTOR_MCP_TOOL_CALL}.`;
    }
    if (interfaces.input && loadedToolNames.includes(HELPER_TOOLS.ACTOR_CALL)) {
        return `${text} It can be run from an input with ${HELPER_TOOLS.ACTOR_CALL}.`;
    }
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
    method: ApiMethod;
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
 * `TextDecoder` does not support the charset. In a JSON body whose escapes hide the token, only the string
 * literals holding it are rewritten, so numbers and formatting stay as sent.
 */
function decodeBody(body: Buffer, charset: string, token: string): string | undefined {
    let text: string;
    try {
        text = new TextDecoder(charset).decode(maskSessionToken(body, token)).replaceAll(token, REDACTED);
    } catch {
        return undefined;
    }
    try {
        if (!JSON.stringify(JSON.parse(text)).includes(token)) return text;
    } catch {
        return text;
    }
    return text.replace(/"(?:[^"\\]|\\.)*"/g, (literal) => {
        const value = JSON.parse(literal) as string;
        return value.includes(token) ? JSON.stringify(value.replaceAll(token, REDACTED)) : literal;
    });
}

/** Longest `errorMessage` returned; the full error stays in `body`. */
const ERROR_MESSAGE_MAX_LENGTH = 1_000;

/**
 * The `error` string of a JSON `{"error": ...}` body, cut to `ERROR_MESSAGE_MAX_LENGTH`; `undefined` for any other
 * body, which the response already carries as `body`.
 */
function getReadableErrorMessage(body: string): string | undefined {
    try {
        const parsed = z.object({ error: z.string() }).safeParse(JSON.parse(body));
        if (!parsed.success) return undefined;
        const { error } = parsed.data;
        return error.length > ERROR_MESSAGE_MAX_LENGTH ? `${error.slice(0, ERROR_MESSAGE_MAX_LENGTH)}…` : error;
    } catch {
        // An Actor can return plain text or malformed JSON.
    }
    return undefined;
}

/** A rejected request's recovery text lists up to this many documented operations, then counts the rest. */
export const RECOVERY_MAX_OPERATIONS = 20;

/** E.g. `Documented operations: GET / (required: query), POST / (required: request body). `; empty without any. */
function formatDocumentedOperations(operations: readonly string[] = []): string {
    if (operations.length === 0) return '';
    const listed = operations.slice(0, RECOVERY_MAX_OPERATIONS);
    const rest = operations.length - listed.length;
    return `Documented operations: ${listed.join(', ')}${rest > 0 ? `, and ${rest} more` : ''}. `;
}

function buildRequestRecoveryText({
    status,
    actorName,
    loadedToolNames,
    hasErrorMessage,
    operations,
}: {
    status: number;
    actorName: string;
    loadedToolNames: readonly string[];
    hasErrorMessage: boolean;
    operations: readonly string[] | undefined;
}): string | undefined {
    if (status === 429) return 'The Actor Server rate limit was reached.';
    if (status === 503) return 'The Actor Server is temporarily unavailable.';
    if (![400, 404, 405, 422].includes(status)) return undefined;
    // Listed here so the agent can retry without first looking the operations up.
    const documentation =
        formatDocumentedOperations(operations) +
        (loadedToolNames.includes(HELPER_TOOLS.ACTOR_GET_DETAILS)
            ? `${HELPER_TOOLS.ACTOR_GET_DETAILS} with ${JSON.stringify({ actor: actorName, output: { serverInterface: true } })} lists the documented HTTP operations.`
            : 'The Actor README may describe its HTTP endpoints.');
    return hasErrorMessage
        ? `The Actor Server error may name the expected HTTP method, path, or parameters. ${documentation}`
        : documentation;
}

/** The tool response for what the Actor Server sent back, with the session token masked. */
function buildResponse(
    request: ServerActorRequest,
    response: ServerActorResponse,
    {
        apifyToken: token,
        loadedToolNames,
        operations,
    }: Pick<InternalToolArgs, 'apifyToken' | 'loadedToolNames'> & { operations?: readonly string[] },
): ToolResponse {
    const { status } = response;
    const contentType = response.contentType?.replaceAll(token, REDACTED);
    const location = response.location?.replaceAll(token, REDACTED);
    const outcome = `${request.method} ${request.path} on ${request.actorName} returned HTTP ${status}`;
    // A 5xx is a failure, as an Apify API 5xx is in the API tools; any other refusal is the caller's.
    const respondError = (texts: string[], structuredContent?: Record<string, unknown>) =>
        status >= 500
            ? respondServerError(texts, { error: { statusCode: status }, structuredContent })
            : respondUserError(texts, {
                  ...((status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN) && {
                      category: FAILURE_CATEGORY.AUTH,
                  }),
                  httpStatus: status,
                  structuredContent,
              });
    const rejectBody = (reason: string) => {
        const summary = `${outcome}. The body is not returned: ${reason}. The request itself was sent.`;
        const structuredContent = {
            ...request,
            status,
            ...(contentType && { contentType }),
            ...(location && { location }),
            ...(response.body !== undefined && { bytes: response.body.length }),
            bodyOmitted: true,
            reason,
            summary,
        };
        return respondError([JSON.stringify(structuredContent), summary], structuredContent);
    };

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
    const errorMessage = status >= 400 && body ? getReadableErrorMessage(body) : undefined;
    const nextStep = buildRequestRecoveryText({
        status,
        actorName: request.actorName,
        loadedToolNames,
        hasErrorMessage: errorMessage !== undefined,
        operations,
    });
    const data = {
        ...request,
        status,
        ...(contentType && { contentType }),
        body,
        bytes,
        ...(location && { location }),
    };
    const structuredContent = {
        ...data,
        summary,
        ...(errorMessage && { errorMessage }),
        ...(nextStep && { nextStep }),
    };
    const texts = [JSON.stringify(data), summary];
    if (errorMessage) texts.push(`Actor Server error: ${errorMessage}`);
    if (nextStep) texts.push(nextStep);
    if (status < 400) return respondOk(texts, { structuredContent });
    return respondError(texts, structuredContent);
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
    if (!args.path.startsWith('/')) return respondUserError('The path must start with "/".');
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
            // With Actor Standby off there is no tenancy; `resolveActorTenancy` would report its single-tenant default.
            ...(info.actorStandby?.isEnabled === true && { actorTenancy: tenancy }),
            ...(httpStatus !== undefined && { httpStatus }),
        },
    });

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
        return withActorTelemetry(
            buildResponse(request, response, {
                apifyToken,
                loadedToolNames,
                operations: definition.webServerOperations,
            }),
            response.status,
        );
    } catch (error) {
        if (signal.aborted) return respondAborted();
        if (!(error instanceof IncompleteResponseError)) throw error;
        return withActorTelemetry(buildIncompleteResponse(request, error, timeoutMillis), error.status);
    }
}

/** The logged arguments: the body can carry secrets, and an Actor Server can take a credential under any query name. */
export function redactServerActorRequestArgs({ actor, query, ...rest }: Record<string, unknown>) {
    return {
        actor,
        ...redactApiCallArgs(rest),
        ...(query !== undefined && {
            query: isRecord(query) ? Object.fromEntries(Object.keys(query).map((name) => [name, REDACTED])) : REDACTED,
        }),
    };
}

function buildDescription({ hasTool }: ToolDescriptionContext): string {
    const details = hasTool(HELPER_TOOLS.ACTOR_GET_DETAILS)
        ? ` ${HELPER_TOOLS.ACTOR_GET_DETAILS} with output.serverInterface returns the documented operations with their parameters.`
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

/** Sends one HTTP request to a Server Actor's API, the server interface its `webServerSchema` documents. */
export const sendServerActorRequest: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_SERVER_REQUEST,
    title: 'Send Server Actor request',
    description: buildDescription(ALL_TOOLS_PRESENT),
    buildDescription,
    inputSchema: toAdvertisedInputSchema(sendServerActorRequestArgs),
    outputSchema: serverActorRequestOutputSchema,
    // The shared validator coerces null and singleton arrays into scalar query values.
    ajvValidate: new Ajv({ coerceTypes: false, strict: false, removeAdditional: true }).compile(
        fixZodSchemaRequired(z.toJSONSchema(sendServerActorRequestArgs)),
    ),
    // A third-party payment provider cannot pay for an Actor Server run, so such a session is rejected before the call.
    hasPaymentProviderStandbyCheck: true,
    actorInterface: 'server',
    annotations: {
        title: 'Send Server Actor request',
        readOnlyHint: false,
        // The agent can send DELETE, PUT, or PATCH to third-party code.
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
    },
    redactArgs: redactServerActorRequestArgs,
    call: async (toolArgs: InternalToolArgs) => executeSendServerActorRequest(toolArgs),
} as const);
