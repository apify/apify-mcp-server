import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { isAxiosError } from 'axios';
import { z } from 'zod';

import type { ApifyClient } from '../../apify_client.js';
import { HELPER_TOOLS, MAX_INLINE_BYTES } from '../../const.js';
import { isMaxContentLengthAbort } from '../../resources/api_resources.js';
import type { ToolResponse } from '../../utils/mcp.js';
import { respondAborted, respondOk, respondUserError } from '../../utils/mcp.js';
import { WAIT_SECS_MAX } from '../actors/actor_run_response.js';
import type { ApiOperation } from './apify_api_spec.js';
import { API_ACCESS, isRecord, SOURCE_BODY_FIELDS } from './apify_api_spec.js';

/** Input fields the read and write tools share. */
export const apiCallArgsShape = {
    path: z
        .string()
        .min(1)
        .describe(
            'The API path with its values in it, for example /v2/datasets/abc/items. A name is written ' +
                'username~name, as in /v2/actors/john~my-actor. Query parameters go in query, not in the path.',
        ),
    query: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe(
            'Query parameters, by name, for example {"limit": 10}. Only parameters the operation declares are accepted.',
        ),
};

/** Query parameters whose values grant access or carry secrets: a storage signature, and webhooks with headers. */
const SECRET_QUERY_PARAMS: readonly string[] = ['token', 'signature', 'webhooks'];

/** Stands in for a logged value that may carry a secret. */
const REDACTED = '[REDACTED]';

/**
 * The logged copy of an API tool call's arguments (`redactArgs`). An allowlist: it keeps the path and
 * method, the query with the values of secret parameters redacted, and only a marker for the body,
 * which can carry environment variable values, webhook headers, or stored records. An undeclared
 * `token` is redacted too, since it is logged before the query check refuses it. So is a query
 * written into the path, such as a public URL's `?signature=`, which the path check refuses only
 * after the arguments are logged. A path or query of the wrong type, which AJV refuses after the
 * arguments are logged, is logged only as a marker.
 */
export function redactApiCallArgs({ path, method, query, body }: Record<string, unknown>) {
    let loggedQuery: unknown;
    if (isRecord(query)) {
        loggedQuery = Object.fromEntries(
            Object.entries(query).map(([name, value]) => [name, SECRET_QUERY_PARAMS.includes(name) ? REDACTED : value]),
        );
    } else if (query !== undefined) {
        loggedQuery = REDACTED;
    }
    let loggedPath: unknown;
    if (typeof path === 'string') loggedPath = path.replace(/[?#][\s\S]*$/, `?${REDACTED}`);
    else if (path !== undefined) loggedPath = REDACTED;
    return {
        path: loggedPath,
        method,
        query: loggedQuery,
        ...(body !== undefined && { body: REDACTED }),
    };
}

const API_PATH_PREFIX = '/v2/';

/** A template segment that is one path parameter, such as `{datasetId}`. */
const PATH_PARAMETER_SEGMENT_REGEX = /^\{[^{}]+\}$/;

/**
 * Checks a request path and returns its segments after `/v2/`, each decoded and encoded again, so a
 * value works both encoded and not. `~` stays as it is. A template placeholder, encoded or not, is
 * refused unless `canBeTemplate` is set: the API would take `{datasetId}` as the value. With
 * `canBeTemplate`, a placeholder stays as the agent wrote it, since it only matches a template's.
 */
export function parseApiPath(path: string, canBeTemplate = false): { segments: string[] } | { error: string } {
    if (!path.startsWith(API_PATH_PREFIX)) {
        return { error: `The path must start with ${API_PATH_PREFIX}, for example /v2/actor-runs. Do not pass a URL.` };
    }
    if (path.includes('?') || path.includes('#')) {
        return {
            error: canBeTemplate
                ? 'The path cannot hold ? or #. Remove the query.'
                : 'The path cannot hold ? or #. Pass query parameters in query.',
        };
    }
    const segments: string[] = [];
    for (const rawSegment of path.slice(API_PATH_PREFIX.length).split('/')) {
        if (!rawSegment) return { error: `The path ${path} has an empty segment. Remove the extra slash.` };
        let value: string;
        let segment: string;
        try {
            value = decodeURIComponent(rawSegment);
            // A lone surrogate decodes, but does not encode.
            segment = encodeURIComponent(value);
        } catch {
            return { error: `The path segment ${rawSegment} is not valid URL encoding. Write a % as %25.` };
        }
        if (PATH_PARAMETER_SEGMENT_REGEX.test(value)) {
            if (!canBeTemplate) return { error: `Replace ${value} in the path with its value.` };
            segments.push(value);
            continue;
        }
        // Encoded or not, `.` and `..` would move the request to another route.
        if (value === '.' || value === '..') return { error: `The path cannot have a ${value} segment.` };
        segments.push(segment);
    }
    return { segments };
}

/** How many literal segments of the template match the path segments, or `undefined` when it does not match. */
function countMatchingLiterals(template: string, segments: string[]): number | undefined {
    const templateSegments = template.slice(API_PATH_PREFIX.length).split('/');
    if (templateSegments.length !== segments.length) return undefined;
    let literalCount = 0;
    for (const [position, templateSegment] of templateSegments.entries()) {
        if (PATH_PARAMETER_SEGMENT_REGEX.test(templateSegment)) continue;
        if (templateSegment !== segments[position]) return undefined;
        literalCount += 1;
    }
    return literalCount;
}

/**
 * The operations on the one path template the segments match, in index order (GET, POST, PUT, DELETE).
 * When several templates match, the one with more literal segments wins, so
 * `/v2/request-queues/x/requests/batch` is the batch operation, not a request with the ID `batch`.
 * The published spec has no tie; the first template wins one.
 */
function findPathOperations(index: Map<string, ApiOperation>, segments: string[]): ApiOperation[] {
    let bestLiteralCount = -1;
    let operations: ApiOperation[] = [];
    for (const operation of index.values()) {
        const literalCount = countMatchingLiterals(operation.path, segments);
        if (literalCount === undefined || literalCount < bestLiteralCount) continue;
        if (literalCount > bestLiteralCount) {
            bestLiteralCount = literalCount;
            operations = [operation];
        } else if (operation.path === operations[0].path) {
            operations.push(operation);
        }
    }
    return operations;
}

/** Words in a sentence, with an Oxford comma: `GET, PUT, and DELETE`. */
function formatList(words: readonly string[], conjunction: 'and' | 'or'): string {
    if (words.length <= 2) return words.join(` ${conjunction} `);
    return `${words.slice(0, -1).join(', ')}, ${conjunction} ${words.at(-1)}`;
}

/** Method names in a sentence: `GET, PUT, and DELETE`. */
function formatMethodList(operations: readonly ApiOperation[]): string {
    return formatList(
        operations.map((operation) => operation.method),
        'and',
    );
}

/** `method POST` or `methods GET and PUT`. */
function formatMatchedMethods(operations: readonly ApiOperation[]): string {
    return `${operations.length === 1 ? 'method' : 'methods'} ${formatMethodList(operations)}`;
}

/**
 * The operations on the path template a request path matches, with the path as it is sent, or why
 * the path is refused. The refusal names the search tool only when the session has it.
 */
export function resolvePathOperations(params: {
    index: Map<string, ApiOperation>;
    path: string;
    loadedToolNames: readonly string[];
    /** Lets the path be a template, such as `/v2/datasets/{datasetId}`; only for describing operations. */
    canBeTemplate?: boolean;
}): { path: string; operations: ApiOperation[] } | { error: string } {
    const parsed = parseApiPath(params.path, params.canBeTemplate);
    if ('error' in parsed) return parsed;
    const path = `${API_PATH_PREFIX}${parsed.segments.join('/')}`;
    const operations = findPathOperations(params.index, parsed.segments);
    if (operations.length > 0) return { path, operations };
    const next = params.loadedToolNames.includes(HELPER_TOOLS.API_SEARCH)
        ? ` Find the path with ${HELPER_TOOLS.API_SEARCH}.`
        : '';
    // A template is fine for describing operations, so only the call tools ask for the values.
    const nameRule = params.canBeTemplate
        ? 'A name is written username~name'
        : 'Write the path with its values in it; a name is written username~name';
    return {
        error: `No Apify API operation matches the path ${path}. ${nameRule}, as in /v2/actors/john~my-actor.${next}`,
    };
}

/** The operation among the matched ones with the method, or why there is none. */
export function resolveMethodOperation(
    path: string,
    operations: readonly ApiOperation[],
    method: string,
): { operation: ApiOperation } | { error: string } {
    const operation = operations.find((candidate) => candidate.method === method);
    if (operation) return { operation };
    return { error: `The path ${path} has no ${method} operation; it matches ${formatMatchedMethods(operations)}.` };
}

/** The refusal of an operation the API tools do not call, or `undefined` when they call it. */
function formatUnavailableMessage(operation: ApiOperation, path: string): string | undefined {
    if (operation.access !== API_ACCESS.UNAVAILABLE) return undefined;
    return `The API tools do not call ${operation.method} ${path}. ${operation.unavailableReason}`;
}

/** The GET operation on the matched path, or why the read tool may not call the path. */
export function resolveReadOperation(
    path: string,
    operations: readonly ApiOperation[],
    loadedToolNames: readonly string[],
): { operation: ApiOperation } | { error: string } {
    const operation = operations.find((candidate) => candidate.method === 'GET');
    if (!operation) {
        return {
            error:
                `The path ${path} matches ${formatMatchedMethods(operations)}, not GET; this tool sends only GET. ` +
                formatReadNextStep(operations, loadedToolNames),
        };
    }
    const unavailableMessage = formatUnavailableMessage(operation, path);
    return unavailableMessage ? { error: unavailableMessage } : { operation };
}

/**
 * Where to call a path without GET: the write tool with the method it may call, else why not. The
 * method is named since a path with several methods needs it, such as a POST and a DELETE.
 */
function formatReadNextStep(operations: readonly ApiOperation[], loadedToolNames: readonly string[]): string {
    // Without GET, each operation has write access or is unavailable.
    const writeMethods = operations
        .filter((candidate) => candidate.access === API_ACCESS.WRITE)
        .map((candidate) => candidate.method);
    if (writeMethods.length === 0) return `The API tools do not call it. ${operations[0].unavailableReason}`;
    return loadedToolNames.includes(HELPER_TOOLS.API_WRITE)
        ? `Call it with ${HELPER_TOOLS.API_WRITE} and method ${writeMethods.join(' or ')}.`
        : 'No tool in this session has write access.';
}

/**
 * The POST or PUT operation on the matched path, or why the write tool may not call it. Without a
 * method, the path's only method is used; a path with several needs the method, since guessing
 * between, say, a create and a delete is not safe.
 */
export function resolveWriteOperation(params: {
    path: string;
    operations: readonly ApiOperation[];
    method?: string;
    loadedToolNames: readonly string[];
}): { operation: ApiOperation } | { error: string } {
    const { path, operations, method, loadedToolNames } = params;
    if (method === undefined && operations.length > 1) {
        return {
            error: `The path matches methods ${formatMethodList(operations)}; specify which one to call the endpoint with.`,
        };
    }
    const resolved =
        method === undefined ? { operation: operations[0] } : resolveMethodOperation(path, operations, method);
    if ('error' in resolved) return resolved;
    const { operation } = resolved;
    const unavailableMessage = formatUnavailableMessage(operation, path);
    if (unavailableMessage) return { error: unavailableMessage };
    if (operation.access === API_ACCESS.READ) {
        const next = loadedToolNames.includes(HELPER_TOOLS.API_READ)
            ? `Call it with ${HELPER_TOOLS.API_READ}.`
            : 'No tool in this session has read access.';
        return { error: `${operation.method} ${path} has read access; this tool has write access. ${next}` };
    }
    return { operation };
}

/** Query values the API reads as true. */
const TRUE_QUERY_VALUES: ReadonlySet<string> = new Set(['true', '1']);

/** Checks the query against the parameters the operation declares; returns the reason on failure. */
export function validateQueryParams(
    operation: ApiOperation,
    query: Record<string, string | number | boolean> = {},
): string | undefined {
    const declared = operation.parameters.filter((parameter) => parameter.in === 'query');
    const declaredNames = new Set(declared.map((parameter) => parameter.name));
    const unknownNames = Object.keys(query).filter((name) => !declaredNames.has(name));
    if (unknownNames.length > 0) {
        return (
            `${operation.method} ${operation.path} does not take the query parameter ${unknownNames.join(', ')}. ` +
            `It takes: ${[...declaredNames].join(', ') || 'none'}.`
        );
    }
    const missingNames = declared
        .filter((parameter) => parameter.isRequired && query[parameter.name] === undefined)
        .map((parameter) => parameter.name);
    if (missingNames.length > 0) return `Missing required query parameter ${missingNames.join(', ')}.`;
    // Same cap as the run and build tools: MCP clients stop waiting for a tool call after 60 seconds.
    // The API reads the value with parseInt, so "60s" waits 60 seconds.
    if (query.waitForFinish !== undefined && Number.parseInt(String(query.waitForFinish), 10) > WAIT_SECS_MAX) {
        // Calling a run or build POST again starts another paid run or build.
        const next =
            operation.method === 'GET'
                ? 'Call the operation again to keep waiting.'
                : 'To keep waiting after that, call GET /v2/actor-runs/{runId} or GET /v2/actor-builds/{buildId} ' +
                  'with waitForFinish; calling this operation again starts another one.';
        return `waitForFinish can be at most ${WAIT_SECS_MAX} seconds. ${next}`;
    }
    // It sets the run's permission level, like the refused actorPermissionLevel body field.
    if (query.forcePermissionLevel !== undefined) {
        return (
            'The API tools do not set forcePermissionLevel, whatever the value: permission changes need a ' +
            'dedicated tool or Apify Console. Remove the parameter and call again.'
        );
    }
    // The log operations' stream keeps the request open while the run or build is running.
    if (query.stream !== undefined && TRUE_QUERY_VALUES.has(String(query.stream).toLowerCase())) {
        return (
            'stream keeps the request open while the run or build is running, longer than MCP clients wait for ' +
            'a tool call. Call again without stream to get the log so far.'
        );
    }
    return undefined;
}

/** Checks the body against the operation; returns the reason on failure. */
export function validateRequestBody(operation: ApiOperation, body: unknown): string | undefined {
    if (!operation.requestBody) {
        return body === undefined ? undefined : `${operation.method} ${operation.path} takes no request body.`;
    }
    if (body === undefined) {
        return operation.requestBody.isRequired
            ? `${operation.method} ${operation.path} needs a request body.`
            : undefined;
    }
    // A JSON-encoded string would reach the API as a string, not as the object, and skip the checks below.
    if (typeof body === 'string' || body === null) {
        return (
            `Pass the body of ${operation.method} ${operation.path} as JSON, usually an object, not as ` +
            `${body === null ? 'null' : 'a string'}.`
        );
    }
    if (!isRecord(body)) return undefined;
    if (operation.replacesEnvVar && typeof body.isSecret !== 'boolean') {
        return (
            `${operation.method} ${operation.path} replaces the whole variable, and the API stores a variable ` +
            'sent without isSecret as plain text. Send isSecret: true to keep a secret variable secret, or ' +
            'isSecret: false.'
        );
    }
    const refusedFields = operation.refusedBodyFields.filter((field) => field in body);
    if (refusedFields.length === 0) return undefined;
    // One refusal lists every refused field, so the agent does not learn of them one call at a time.
    const sourceFields = refusedFields.filter((field) => SOURCE_BODY_FIELDS.has(field));
    const otherFields = refusedFields.filter((field) => !SOURCE_BODY_FIELDS.has(field));
    const sentences: string[] = [];
    if (otherFields.length > 0) {
        sentences.push(
            `The API tools do not set ${otherFields.join(', ')}, whatever the value: publishing, pricing, ` +
                'permission, and sharing changes need a dedicated tool or Apify Console.',
        );
    }
    if (sourceFields.length > 0) {
        sentences.push(
            `The API tools do not set ${sourceFields.join(', ')}: they set an Actor's source, versions, or ` +
                'environment variables, which dedicated source tools or Apify Console change.',
        );
    }
    // Paths, not tool names: this same tool calls them, and each changes one variable.
    if (sourceFields.includes('envVars')) {
        sentences.push(
            'To add or change one environment variable, call POST ' +
                '/v2/actors/{actorId}/versions/{versionNumber}/env-vars or PUT ' +
                '/v2/actors/{actorId}/versions/{versionNumber}/env-vars/{envVarName}; each leaves the other ' +
                'variables as they are. The PUT replaces the whole variable, so send isSecret with it.',
        );
    }
    // Sending the rest of an otherwise empty body would succeed and change nothing.
    const isNothingElseSet = Object.keys(body).every((field) => refusedFields.includes(field));
    sentences.push(
        isNothingElseSet
            ? 'Without the refused fields the body sets nothing, so do not call again with it.'
            : 'Remove the refused fields and call again.',
    );
    return sentences.join(' ');
}

/** Query parameters that make a response smaller. */
const NARROWING_QUERY_PARAMS: readonly string[] = ['limit', 'offset', 'fields', 'omit'];

/** The dedicated tool that returns the end of a log too large for the API tools, when the session has it. */
function findLogToolName(path: string, loadedToolNames: readonly string[]): string | undefined {
    if (!/\/log$|^\/v2\/logs\//.test(path)) return undefined;
    const toolName = path.startsWith('/v2/actor-builds/') ? HELPER_TOOLS.ACTOR_BUILD_LOG : HELPER_TOOLS.ACTOR_RUNS_LOG;
    return loadedToolNames.includes(toolName) ? toolName : undefined;
}

/** The refusal of a response over the inline limit, with the parameters the operation has to narrow it. */
function formatOversizeMessage(operation: ApiOperation, path: string, loadedToolNames: readonly string[]): string {
    const narrowingNames = operation.parameters
        .filter((parameter) => parameter.in === 'query' && NARROWING_QUERY_PARAMS.includes(parameter.name))
        .map((parameter) => parameter.name);
    const logToolName = findLogToolName(operation.path, loadedToolNames);
    let next: string;
    if (operation.method !== 'GET') {
        next = 'The request itself was sent; check its effect with an operation with read access.';
    } else if (narrowingNames.length > 0) {
        next = `Narrow the request with the ${formatList(narrowingNames, 'or')} query parameter.`;
    } else if (logToolName) {
        next = `Get the end of the log with ${logToolName} instead.`;
    } else {
        next = 'The operation has no query parameter that narrows it, so the API tools cannot return it.';
    }
    return `The response of ${operation.method} ${path} is larger than ${MAX_INLINE_BYTES} bytes, so it is not returned. ${next}`;
}

/** The status of a response axios aborted mid-body; Node's request object keeps the response it got. */
function readAbortedResponseStatus(error: unknown): number | undefined {
    const request: unknown = isAxiosError(error) ? error.request : undefined;
    const statusCode = isRecord(request) && isRecord(request.res) ? request.res.statusCode : undefined;
    return typeof statusCode === 'number' ? statusCode : undefined;
}

/**
 * The request failure as a plain error with its message and code. The axios error keeps the request
 * config, which holds the Authorization header and the request body, and the tool error log prints
 * the whole error.
 */
function toPlainRequestError(error: unknown): Error {
    if (!(error instanceof Error)) return new Error(String(error));
    const { code } = error as { code?: unknown };
    return Object.assign(new Error(error.message), typeof code === 'string' ? { code } : {});
}

/**
 * Sends one request to a matched operation's path and returns the response body.
 *
 * It goes through the client's axios instance, not `httpClient.call()`, like `readApiResource`: one
 * attempt and no retries, since a retried write could apply twice, and apify-client would retry the
 * `maxContentLength` abort as a network error. The instance still adds the token and the request-origin
 * and payment headers, and parses JSON and text bodies. Like `readApiResource`, the request skips the
 * setup `httpClient.call()` runs first, so it does not honor `HTTPS_PROXY` and goes out with axios's
 * default User-Agent instead of apify-client's. A non-2xx response is thrown as the `ApifyApiError`
 * apify-client itself builds, so it gets the usual tool error text and telemetry.
 */
export async function callApiOperation(params: {
    client: ApifyClient;
    operation: ApiOperation;
    path: string;
    query?: Record<string, string | number | boolean>;
    /** JSON request body; only the write tool sends one. */
    body?: unknown;
    /** Aborts the request when the client cancels the tool call. */
    signal?: AbortSignal;
    /** The session's tools, to name a dedicated log tool when a log is too large. */
    loadedToolNames: readonly string[];
}): Promise<ToolResponse> {
    const { client, operation, path } = params;
    let response: AxiosResponse<unknown>;
    try {
        response = await client.httpClient.axios.request<unknown>({
            // `client.baseUrl` already ends with /v2, the prefix of every indexed path.
            url: `${client.baseUrl}${path.slice('/v2'.length)}`,
            method: operation.method,
            params: params.query,
            // Serialized here: axios would send a string as a form and refuse a number. With only the JSON
            // header, a JSON-looking string would reach the API as the object it holds.
            ...(params.body !== undefined && {
                data: JSON.stringify(params.body),
                headers: { 'Content-Type': 'application/json' },
            }),
            maxContentLength: MAX_INLINE_BYTES,
            signal: params.signal,
        });
    } catch (error) {
        // A cancelled call is not a tool error; like the run and build tools, it gets the empty response.
        if (params.signal?.aborted) return respondAborted();
        if (isMaxContentLengthAbort(error)) {
            // A write has applied by the time its response arrives, so a large response is not a failure.
            const statusCode = readAbortedResponseStatus(error);
            if (operation.method !== 'GET' && statusCode !== undefined && statusCode < 300) {
                const structuredContent = {
                    method: operation.method,
                    path,
                    statusCode,
                    data: null,
                };
                const summary =
                    `${operation.method} ${path} returned HTTP ${statusCode}. The response is larger than ` +
                    `${MAX_INLINE_BYTES} bytes, so it is not returned; check the result with an operation with read access.`;
                return respondOk([JSON.stringify(structuredContent), summary], { structuredContent });
            }
            // The status says the write failed; the generic message would say it may have applied.
            if (operation.method !== 'GET' && statusCode !== undefined) {
                return respondUserError(
                    `${operation.method} ${path} failed with HTTP ${statusCode}. Its error body is larger than ` +
                        `${MAX_INLINE_BYTES} bytes, so it is not returned.`,
                );
            }
            return respondUserError(formatOversizeMessage(operation, path, params.loadedToolNames));
        }
        throw toPlainRequestError(error);
    }
    if (response.status >= 300) throw new ApifyApiError(response, 1);

    const contentTypeHeader = response.headers['content-type'];
    const contentType = typeof contentTypeHeader === 'string' ? contentTypeHeader : undefined;
    // apify-client parses JSON and text bodies; a binary body stays a Buffer and is not returned.
    const isBinary = Buffer.isBuffer(response.data);
    const structuredContent = {
        method: operation.method,
        path,
        statusCode: response.status,
        ...(contentType && { contentType }),
        data: isBinary || response.data === undefined ? null : response.data,
    };
    const summary = isBinary
        ? `${operation.method} ${path} returned HTTP ${response.status} with a binary body ` +
          `(${contentType ?? 'no Content-Type'}, ${(response.data as Buffer).length} bytes), which is not shown.`
        : `${operation.method} ${path} returned HTTP ${response.status}.`;
    return respondOk([JSON.stringify(structuredContent), summary], { structuredContent });
}
