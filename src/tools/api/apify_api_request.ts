import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { z } from 'zod';

import type { ApifyClient } from '../../apify_client.js';
import { HELPER_TOOLS, MAX_INLINE_BYTES } from '../../const.js';
import { isMaxContentLengthAbort } from '../../resources/api_resources.js';
import type { ToolResponse } from '../../utils/mcp.js';
import { respondAborted, respondOk, respondUserError } from '../../utils/mcp.js';
import { WAIT_SECS_MAX } from '../actors/actor_run_response.js';
import type { ApiMethod, ApiOperation } from './apify_api_spec.js';
import { fetchApiOperationIndex, isRecord } from './apify_api_spec.js';

/** Input fields the read and write tools share. */
export const apiCallArgsShape = {
    path: z
        .string()
        .min(1)
        .describe(
            'The API path with its values in it: acts, v2/acts, and /v2/acts are the same. A name is written ' +
                'username~name, as in /v2/acts/john~my-actor. A query string written into the path is sent too.',
        ),
    query: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe('Query parameters, by name, for example {"limit": 10}. Added to a query string in the path.'),
};

/** The shared description lines of the read and write tools. */
export const API_CALL_DESCRIPTION = `A proxy to the Apify API, like apify api in the Apify CLI; the server adds the host and the API token.
Write the path as acts, v2/acts, or /v2/acts, with its values in it; a name is written username~name.
Synchronous runs, and waitForFinish above ${WAIT_SECS_MAX} seconds, outlast the usual 60-second tool-call timeout,
so prefer asynchronous runs.`;

/** Query parameters whose values grant access or carry secrets: a token, a storage signature, and webhooks with headers. */
const SECRET_QUERY_PARAMS: readonly string[] = ['token', 'signature', 'webhooks'];

/** Stands in for a logged or returned value that may carry a secret. */
const REDACTED = '[REDACTED]';

/**
 * The logged copy of an API tool call's arguments (`redactArgs`). An allowlist: it keeps the path and
 * method, the query with the values of secret parameters redacted, and only a marker for the body,
 * which can carry environment variable values, webhook headers, or stored records. A query written
 * into the path, such as a public URL's `?signature=`, is logged only as a marker. A path or query of
 * the wrong type, which AJV refuses after the arguments are logged, is logged only as a marker.
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

/**
 * A path as the Apify CLI's `apify api` takes it, without its `v2/` prefix: `acts`, `v2/acts`, and
 * `/v2/acts` all become `acts`. One leading slash is removed, then the prefix, in any case.
 */
export function normalizeApiPath(path: string): string {
    return path.replace(/^\//, '').replace(/^v2\//i, '');
}

/** A normalized path as the tools report it, with the `/v2/` prefix. */
export function formatApiPath(normalizedPath: string): string {
    return `/v2/${normalizedPath}`;
}

/** A path without the query string or fragment written into it. */
function stripQuery(path: string): string {
    return path.replace(/[?#][\s\S]*$/, '');
}

const PATH_PARAMETER_SEGMENT_REGEX = /^\{[^{}]+\}$/;

/** How many literal segments of the template match the path segments, or `undefined` when it does not match. */
function countMatchingLiterals(template: string, segments: string[]): number | undefined {
    const templateSegments = normalizeApiPath(template).split('/');
    if (templateSegments.length !== segments.length) return undefined;
    let literalCount = 0;
    for (const [position, templateSegment] of templateSegments.entries()) {
        if (PATH_PARAMETER_SEGMENT_REGEX.test(templateSegment)) {
            if (!segments[position]) return undefined;
            continue;
        }
        if (templateSegment !== segments[position]) return undefined;
        literalCount += 1;
    }
    return literalCount;
}

/**
 * The operations on the one path template a normalized path matches, in index order (GET, POST, PUT,
 * DELETE). The path can have values in it or be a template. When several templates match, the one
 * with more literal segments wins, so `request-queues/x/requests/batch` is the batch operation, not a
 * request with the ID `batch`. The published spec has no tie; the first template wins one.
 */
export function findPathOperations(index: Map<string, ApiOperation>, normalizedPath: string): ApiOperation[] {
    const segments = stripQuery(normalizedPath).split('/');
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

/**
 * Up to five path templates closest to a normalized path, best first, scored as the Apify CLI's
 * `findClosestEndpoints`.
 */
export function findClosestApiPaths(index: Map<string, ApiOperation>, normalizedPath: string): string[] {
    const input = stripQuery(normalizedPath).toLowerCase();
    const inputSegments = input.split('/').filter(Boolean);
    const scores = new Map<string, number>();
    for (const template of new Set([...index.values()].map((operation) => operation.path))) {
        const candidate = normalizeApiPath(template).toLowerCase();
        let score = candidate.includes(input) || input.includes(candidate) ? 10 : 0;
        const segments = candidate.split('/').filter(Boolean);
        for (let position = 0; position < Math.min(inputSegments.length, segments.length); position++) {
            if (segments[position] === inputSegments[position]) score += 2;
            else if (segments[position].startsWith('{')) score += 1;
        }
        if (segments.length === inputSegments.length) score += 1;
        if (score > 0) scores.set(template, score);
    }
    return [...scores]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 5)
        .map(([template]) => template);
}

/** Words in a sentence, with an Oxford comma: `GET, PUT, and DELETE`. */
export function formatList(words: readonly string[], conjunction: 'and' | 'or'): string {
    if (words.length <= 2) return words.join(` ${conjunction} `);
    return `${words.slice(0, -1).join(', ')}, ${conjunction} ${words.at(-1)}`;
}

/** The index, or `undefined` when the spec cannot be loaded; for the hints that only help. */
async function fetchApiOperationIndexIfAvailable(): Promise<Map<string, ApiOperation> | undefined> {
    return fetchApiOperationIndex().catch(() => undefined);
}

/** Query parameters that make a response smaller. */
const NARROWING_QUERY_PARAMS: readonly string[] = ['limit', 'offset', 'fields', 'omit'];

/** The dedicated tool that returns the end of a log too large for the API tools, when the session has it. */
function findLogToolName(path: string, loadedToolNames: readonly string[]): string | undefined {
    if (!/\/log$|^\/v2\/logs\//.test(path)) return undefined;
    const toolName = path.startsWith('/v2/actor-builds/') ? HELPER_TOOLS.ACTOR_BUILD_LOG : HELPER_TOOLS.ACTOR_RUNS_LOG;
    return loadedToolNames.includes(toolName) ? toolName : undefined;
}

/**
 * The message of a response over the inline limit. It names the parameters that narrow the response
 * when the path matches an operation of the spec that declares them.
 */
async function formatOversizeMessage(
    method: ApiMethod,
    normalizedPath: string,
    loadedToolNames: readonly string[],
): Promise<string> {
    const path = formatApiPath(normalizedPath);
    const message = `The response of ${method} ${path} is larger than ${MAX_INLINE_BYTES} bytes, so it is not returned.`;
    const index = await fetchApiOperationIndexIfAvailable();
    const operation = index && findPathOperations(index, normalizedPath).find((match) => match.method === method);
    const narrowingNames = (operation?.parameters ?? [])
        .filter((parameter) => parameter.in === 'query' && NARROWING_QUERY_PARAMS.includes(parameter.name))
        .map((parameter) => parameter.name);
    if (narrowingNames.length > 0) {
        return `${message} Narrow the request with the ${formatList(narrowingNames, 'or')} query parameter.`;
    }
    const logToolName = findLogToolName(stripQuery(path), loadedToolNames);
    return logToolName ? `${message} Get the end of the log with ${logToolName} instead.` : message;
}

/** Adds the closest paths of the spec to a 404 error, when the spec is available. */
async function addClosestPaths(error: ApifyApiError, normalizedPath: string): Promise<void> {
    const index = await fetchApiOperationIndexIfAvailable();
    const paths = index ? findClosestApiPaths(index, normalizedPath) : [];
    if (paths.length === 0) return;
    error.message = `${error.message.replace(/\.$/, '')}. The closest paths in the API spec: ${paths.join(', ')}`;
}

/**
 * A copy of a response body with the session's token replaced, for example in `GET /v2/browser-info`,
 * which echoes the request headers. A binary body is returned as it is; it is never shown.
 */
function maskToken(data: unknown, token: string | undefined): unknown {
    if (!token || data === undefined || Buffer.isBuffer(data)) return data;
    const text = JSON.stringify(data);
    // The token as it appears inside a JSON string.
    const escapedToken = JSON.stringify(token).slice(1, -1);
    return text.includes(escapedToken) ? JSON.parse(text.replaceAll(escapedToken, REDACTED)) : data;
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
 * Sends one request to an API path and returns the response body, like `apify api` in the Apify CLI.
 *
 * The URL is the client's base URL and the normalized path, with a query string in the path kept
 * and the query parameters added after it. The path is not checked or encoded again: the agent
 * encodes values. Only the origin is checked, so the token never goes to another host.
 *
 * It goes through the client's axios instance, not `httpClient.call()`, like `readApiResource`: one
 * attempt and no retries, since a retried write could apply twice, and apify-client would retry the
 * `maxContentLength` abort as a network error. The instance still adds the token and the request-origin
 * and payment headers, and parses JSON and text bodies. Like `readApiResource`, the request skips the
 * setup `httpClient.call()` runs first, so it does not honor `HTTPS_PROXY` and goes out with axios's
 * default User-Agent instead of apify-client's. A non-2xx response is thrown as the `ApifyApiError`
 * apify-client itself builds, so it gets the usual tool error text and telemetry.
 */
export async function callApi(params: {
    client: ApifyClient;
    /** The session's token, masked in the response. */
    token?: string;
    method: ApiMethod;
    path: string;
    query?: Record<string, string | number | boolean>;
    /** Aborts the request when the client cancels the tool call. */
    signal?: AbortSignal;
    /** The session's tools, to name a dedicated log tool when a log is too large. */
    loadedToolNames: readonly string[];
}): Promise<ToolResponse> {
    const { client, method } = params;
    const normalizedPath = normalizeApiPath(params.path);
    const path = formatApiPath(normalizedPath);
    // `client.baseUrl` already ends with /v2.
    const url = `${client.baseUrl}/${normalizedPath}`;
    if (new URL(url).origin !== new URL(client.baseUrl).origin) {
        return respondUserError(`The path ${path} leads outside the Apify API. Pass a path, not a URL.`);
    }
    let response: AxiosResponse<unknown>;
    try {
        response = await client.httpClient.axios.request<unknown>({
            url,
            method,
            params: params.query,
            maxContentLength: MAX_INLINE_BYTES,
            signal: params.signal,
        });
    } catch (error) {
        // A cancelled call is not a tool error; like the run and build tools, it gets the empty response.
        if (params.signal?.aborted) return respondAborted();
        if (isMaxContentLengthAbort(error)) {
            return respondUserError(await formatOversizeMessage(method, normalizedPath, params.loadedToolNames));
        }
        throw toPlainRequestError(error);
    }
    const data = maskToken(response.data, params.token);
    if (response.status >= 300) {
        const error = new ApifyApiError({ ...response, data }, 1);
        if (response.status === 404) await addClosestPaths(error, normalizedPath);
        throw error;
    }

    const contentTypeHeader = response.headers['content-type'];
    const contentType = typeof contentTypeHeader === 'string' ? contentTypeHeader : undefined;
    // apify-client parses JSON and text bodies; a binary body stays a Buffer and is not returned.
    const isBinary = Buffer.isBuffer(data);
    const structuredContent = {
        method,
        path,
        statusCode: response.status,
        ...(contentType && { contentType }),
        data: isBinary || data === undefined ? null : data,
    };
    const summary = isBinary
        ? `${method} ${path} returned HTTP ${response.status} with a binary body ` +
          `(${contentType ?? 'no Content-Type'}, ${(data as Buffer).length} bytes), which is not shown.`
        : `${method} ${path} returned HTTP ${response.status}.`;
    return respondOk([JSON.stringify(structuredContent), summary], { structuredContent });
}
