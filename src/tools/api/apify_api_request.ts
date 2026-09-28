import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { z } from 'zod';

import type { ApifyClient } from '../../apify_client.js';
import { HELPER_TOOLS, MAX_INLINE_BYTES } from '../../const.js';
import { isMaxContentLengthAbort } from '../../resources/api_resources.js';
import type { ToolResponse } from '../../utils/mcp.js';
import { respondAborted, respondOk, respondUserError } from '../../utils/mcp.js';
import { WAIT_SECS_MAX } from '../actors/actor_run_response.js';
import type { ApiOperation } from './apify_api_spec.js';
import { API_ACCESS, isRecord } from './apify_api_spec.js';

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

/**
 * The logged copy of an API tool call's arguments (`redactArgs`). An allowlist: it keeps the path and
 * method, the query with the values of secret parameters redacted, and only a marker for the body,
 * which can carry environment variable values, webhook headers, or stored records. An undeclared
 * `token` is redacted too, since it is logged before the query check refuses it.
 */
export function redactApiCallArgs({ path, method, query, body }: Record<string, unknown>) {
    return {
        path,
        method,
        query: isRecord(query)
            ? Object.fromEntries(
                  Object.entries(query).map(([name, value]) => [
                      name,
                      SECRET_QUERY_PARAMS.includes(name) ? '[REDACTED]' : value,
                  ]),
              )
            : query,
        ...(body !== undefined && { body: '[REDACTED]' }),
    };
}

const API_PATH_PREFIX = '/v2/';

/** A template segment that is one path parameter, such as `{datasetId}`. */
const PATH_PARAMETER_SEGMENT_REGEX = /^\{[^{}]+\}$/;

/**
 * Checks a request path and returns its segments after `/v2/`, each decoded and encoded again, so a
 * value works both encoded and not. `~` stays as it is. A template placeholder is refused unless
 * `canBeTemplate` is set: the API would take `{datasetId}` as the value.
 */
export function parseApiPath(path: string, canBeTemplate = false): { segments: string[] } | { error: string } {
    if (!path.startsWith(API_PATH_PREFIX)) {
        return { error: `The path must start with ${API_PATH_PREFIX}, for example /v2/actor-runs. Do not pass a URL.` };
    }
    if (path.includes('?') || path.includes('#')) {
        return { error: 'The path cannot hold ? or #. Pass query parameters in query.' };
    }
    const segments: string[] = [];
    for (const rawSegment of path.slice(API_PATH_PREFIX.length).split('/')) {
        if (!rawSegment) return { error: `The path ${path} has an empty segment. Remove the extra slash.` };
        if (!canBeTemplate && PATH_PARAMETER_SEGMENT_REGEX.test(rawSegment)) {
            return { error: `Replace ${rawSegment} in the path with its value.` };
        }
        let value: string;
        try {
            value = decodeURIComponent(rawSegment);
        } catch {
            return { error: `The path segment ${rawSegment} is not valid URL encoding. Write a % as %25.` };
        }
        // Encoded or not, `.` and `..` would move the request to another route.
        if (value === '.' || value === '..') return { error: `The path cannot have a ${value} segment.` };
        segments.push(encodeURIComponent(value));
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
 * When several templates match, the one with more literal segments wins, so `/v2/actors/x/runs/last`
 * is the last run, not a run with the ID `last`. The published spec has no tie; the first template wins one.
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

/** Method names in a sentence, with an Oxford comma: `GET, PUT, and DELETE`. */
function formatMethodList(operations: readonly ApiOperation[]): string {
    const methods = operations.map((operation) => operation.method);
    if (methods.length <= 2) return methods.join(' and ');
    return `${methods.slice(0, -1).join(', ')}, and ${methods.at(-1)}`;
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
    return {
        error:
            `No Apify API operation matches the path ${path}. Write the path with its values in it; ` +
            `a name is written username~name, as in /v2/actors/john~my-actor.${next}`,
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
export function formatUnavailableMessage(operation: ApiOperation, path: string): string | undefined {
    if (operation.access !== API_ACCESS.UNAVAILABLE) return undefined;
    return `The API tools do not call ${operation.method} ${path}. ${operation.unavailableReason}`;
}

/** The GET operation on the matched path, or why the read tool may not call the path. */
export function resolveReadOperation(
    path: string,
    operations: readonly ApiOperation[],
): { operation: ApiOperation } | { error: string } {
    const operation = operations.find((candidate) => candidate.method === 'GET');
    if (!operation) {
        return {
            error:
                `The path ${path} matches ${formatMatchedMethods(operations)}, not GET; this tool sends only GET. ` +
                'No tool in this session has write access.',
        };
    }
    const unavailableMessage = formatUnavailableMessage(operation, path);
    return unavailableMessage ? { error: unavailableMessage } : { operation };
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
        return `waitForFinish can be at most ${WAIT_SECS_MAX} seconds. Call the operation again to keep waiting.`;
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

function formatOversizeMessage(operation: ApiOperation, path: string): string {
    return (
        `The response of ${operation.method} ${path} is larger than ${MAX_INLINE_BYTES} bytes, so it is not returned. ` +
        'Narrow the request, for example with the limit, offset, or fields query parameters if the operation declares them.'
    );
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
    /** Aborts the request when the client cancels the tool call. */
    signal?: AbortSignal;
}): Promise<ToolResponse> {
    const { client, operation, path } = params;
    let response: AxiosResponse<unknown>;
    try {
        response = await client.httpClient.axios.request<unknown>({
            // `client.baseUrl` already ends with /v2, the prefix of every indexed path.
            url: `${client.baseUrl}${path.slice('/v2'.length)}`,
            method: operation.method,
            params: params.query,
            maxContentLength: MAX_INLINE_BYTES,
            signal: params.signal,
        });
    } catch (error) {
        // A cancelled call is not a tool error; like the run and build tools, it gets the empty response.
        if (params.signal?.aborted) return respondAborted();
        if (isMaxContentLengthAbort(error)) return respondUserError(formatOversizeMessage(operation, path));
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
