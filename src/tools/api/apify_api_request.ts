import { setTimeout as sleep } from 'node:timers/promises';

import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { z } from 'zod';

import type { ApifyClient } from '../../apify_client.js';
import { HELPER_TOOLS, MAX_INLINE_BYTES } from '../../const.js';
import { isApifyApiUri, isMaxContentLengthAbort, sendApifyApiRequest } from '../../resources/api_resources.js';
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
            'The API path with its values in it: actors, v2/actors, and /v2/actors are the same. A name is ' +
                'written username~name, as in /v2/actors/john~my-actor. A query string written into the path is ' +
                'sent too.',
        ),
    query: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe('Query parameters, by name, for example {"limit": 10}. Added to a query string in the path.'),
};

/** The shared description lines of the read and write tools. */
export const API_CALL_DESCRIPTION = `A proxy to the Apify API, like apify api in the Apify CLI; the server adds the host and the API token.
Write the path as actors, v2/actors, or /v2/actors, with its values in it; a name is written username~name.
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
 * A path as the Apify CLI's `apify api` takes it, without its `v2/` prefix: `actors`, `v2/actors`, and
 * `/v2/actors` all become `actors`. One leading slash is removed, then the prefix, in any case.
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

/**
 * A normalized path as the spec lists it, without its query. The API routes the legacy `acts` prefix,
 * which apify-client and the CLI send, to the same handler as `actors`, the only prefix the spec lists.
 */
function toSpecPath(normalizedPath: string): string {
    return stripQuery(normalizedPath).replace(/^acts(?=\/|$)/, 'actors');
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
    const segments = toSpecPath(normalizedPath).split('/');
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
    const input = toSpecPath(normalizedPath).toLowerCase();
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

/** How long a hint waits for the spec, so a stalled download does not hold back the API's answer. */
const HINT_SPEC_TIMEOUT_MS = 5_000;

/**
 * The index, or `undefined` when the spec cannot be loaded within a few seconds or the call is
 * cancelled; for the hints that only help.
 */
async function fetchApiOperationIndexIfAvailable(signal?: AbortSignal): Promise<Map<string, ApiOperation> | undefined> {
    return Promise.race([
        fetchApiOperationIndex(),
        sleep(HINT_SPEC_TIMEOUT_MS, undefined, { signal, ref: false }),
    ]).catch(() => undefined);
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
    signal?: AbortSignal,
): Promise<string> {
    const path = formatApiPath(normalizedPath);
    const message = `The response of ${method} ${path} is larger than ${MAX_INLINE_BYTES} bytes, so it is not returned.`;
    const index = await fetchApiOperationIndexIfAvailable(signal);
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
async function addClosestPaths(error: ApifyApiError, normalizedPath: string, signal?: AbortSignal): Promise<void> {
    const index = await fetchApiOperationIndexIfAvailable(signal);
    const paths = index ? findClosestApiPaths(index, normalizedPath) : [];
    if (paths.length === 0) return;
    error.message = `${error.message.replace(/\.$/, '')}. The closest paths in the API spec: ${paths.join(', ')}`;
}

/**
 * A copy of a response body with the session's token replaced, for example in `GET /v2/browser-info`,
 * which echoes the request headers. A binary body is masked too, since apify-client reads an error
 * body that stays a Buffer into the error message.
 */
function maskToken(data: unknown, token: string | undefined): unknown {
    if (!token || data === undefined) return data;
    if (Buffer.isBuffer(data)) {
        // The token is ASCII, so a latin1 round trip keeps every other byte as it is.
        const bytes = data.toString('latin1');
        return bytes.includes(token) ? Buffer.from(bytes.replaceAll(token, REDACTED), 'latin1') : data;
    }
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
 * encodes values. The URL starts with the base URL's `/v2/`, so no path can lead to another host;
 * the API resource's origin gate, `isApifyApiUri`, asserts it.
 *
 * It sends the request with the API resource's `sendApifyApiRequest`, which says why that is one
 * attempt with no retries and the body capped at `MAX_INLINE_BYTES`, and the resource's
 * `isMaxContentLengthAbort` detects the abort of a larger body. Unlike the resource, it does not
 * stream the body, so the instance parses JSON and text bodies. Like the resource, the instance adds
 * the token and the request-origin and payment headers. A non-2xx response is thrown as the
 * `ApifyApiError` apify-client itself builds, so it gets the usual tool error text and telemetry.
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
    // An assertion with the resource's origin gate: nothing after the base URL's `/v2/` can change
    // the host that gets the token.
    if (!isApifyApiUri(url)) throw new Error(`The URL ${url} is not on the API host.`);
    let response: AxiosResponse<unknown>;
    try {
        response = await sendApifyApiRequest(client, { url, method, params: params.query, signal: params.signal });
    } catch (error) {
        // A cancelled call is not a tool error; like the run and build tools, it gets the empty response.
        if (params.signal?.aborted) return respondAborted();
        if (isMaxContentLengthAbort(error)) {
            return respondUserError(
                await formatOversizeMessage(method, normalizedPath, params.loadedToolNames, params.signal),
            );
        }
        throw toPlainRequestError(error);
    }
    const data = maskToken(response.data, params.token);
    if (response.status >= 300) {
        // Without the query written into the path: apify-client puts the URL into the error's path and
        // stack, and a 5xx error is logged, so a signature or token there would reach the log.
        const error = new ApifyApiError({ ...response, data, config: { ...response.config, url: stripQuery(url) } }, 1);
        if (response.status === 404) await addClosestPaths(error, normalizedPath, params.signal);
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
