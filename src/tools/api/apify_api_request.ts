import { setTimeout as sleep } from 'node:timers/promises';

import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { z } from 'zod';

import type { ApifyClient } from '../../apify_client.js';
import { sendApifyApiRequest } from '../../apify_client.js';
import { APIFY_ERROR_TYPE_PAGE_NOT_FOUND, HELPER_TOOLS, MAX_INLINE_BYTES } from '../../const.js';
import {
    isApifyApiUri,
    isMaxContentLengthAbort,
    maskSessionToken,
    REDACTED,
    redactUrlSigningSecretKey,
    toPlainRequestError,
} from '../../resources/api_resources.js';
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
                'written username~name, or ~name for one you own, as in /v2/actors/~my-actor. ' +
                'A query string written into the path is sent too.',
        ),
    query: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe('Query parameters, by name, for example {"limit": 10}. Added to a query string in the path.'),
};

/** The shared description lines of the read and write tools. */
export const API_CALL_DESCRIPTION = `A proxy to the Apify API, like apify api in the Apify CLI; the server adds the host and the API token.
Write the path as actors, v2/actors, or /v2/actors, with its values in it.
A name is written username~name, or ~name for one you own, as in /v2/actors/~my-actor.
Synchronous runs, and waitForFinish above ${WAIT_SECS_MAX} seconds, outlast the usual 60-second tool-call timeout,
so prefer asynchronous runs.`;

/** Query parameters whose values grant access or carry secrets; `webhooks` can hold webhook headers. */
const SECRET_QUERY_PARAMS: readonly string[] = ['token', 'signature', 'webhooks'];

/**
 * The logged copy of an API tool call's arguments (`redactArgs`), built as an allowlist. Secret query
 * values, a query written into the path, the body, and a path or query of the wrong type are logged
 * only as a marker. The body can carry environment variable values, webhook headers, or stored records.
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

/** A path without its leading slash and `v2/` prefix, as `apify api` takes it: `/v2/actors` becomes `actors`. */
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
 * The operations on the one path template a normalized path, with values or as a template, matches. When
 * several match, the one with more literal segments wins, so `request-queues/x/requests/batch` is the
 * batch operation, not a request with the ID `batch`.
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
async function formatOversizeMessage({
    method,
    normalizedPath,
    loadedToolNames,
    signal,
}: {
    method: ApiMethod;
    normalizedPath: string;
    loadedToolNames: readonly string[];
    signal?: AbortSignal;
}): Promise<string> {
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

/** Adds the spec's closest paths to the message of a page-not-found error, when the spec is available. */
async function addClosestPaths(error: ApifyApiError, normalizedPath: string, signal?: AbortSignal): Promise<void> {
    const index = await fetchApiOperationIndexIfAvailable(signal);
    const paths = index ? findClosestApiPaths(index, normalizedPath) : [];
    if (paths.length === 0) return;
    error.message = `${error.message.replace(/([^.!?])$/, '$1.')} The closest paths in the API spec: ${paths.join(', ')}`;
}

/**
 * A copy of a response body with the session's token replaced, since a response can echo it, as
 * `GET /v2/browser-info` echoes the request headers. A binary body is masked too: apify-client copies a
 * Buffer error body into the message.
 */
function maskToken(data: unknown, token: string | undefined): unknown {
    if (!token || data === undefined) return data;
    if (Buffer.isBuffer(data)) return maskSessionToken(data, token);
    const text = JSON.stringify(data);
    // The token as it appears inside a JSON string.
    const escapedToken = JSON.stringify(token).slice(1, -1);
    return text.includes(escapedToken) ? JSON.parse(text.replaceAll(escapedToken, REDACTED)) : data;
}

/**
 * Sends one request to an API path and returns the response body, like `apify api` in the Apify CLI.
 * The URL is the client's base URL and the normalized path, not encoded again, with `query` added.
 * It sends with `sendApifyApiRequest` (one attempt, body capped at `MAX_INLINE_BYTES`) and throws a
 * non-2xx response as apify-client's `ApifyApiError`, so it gets the usual tool error text and telemetry.
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
    // An assertion: nothing after the base URL can change the host that gets the token.
    if (!isApifyApiUri(url)) throw new Error(`The URL ${url} is not on the API host.`);
    let response: AxiosResponse<unknown>;
    try {
        response = await sendApifyApiRequest(client, { url, method, params: params.query, signal: params.signal });
    } catch (error) {
        // A cancelled call is not a tool error.
        if (params.signal?.aborted) return respondAborted();
        if (isMaxContentLengthAbort(error)) {
            return respondUserError(
                await formatOversizeMessage({
                    method,
                    normalizedPath,
                    loadedToolNames: params.loadedToolNames,
                    signal: params.signal,
                }),
            );
        }
        throw toPlainRequestError(error);
    }
    const data = maskToken(response.data, params.token);
    if (response.status >= 300) {
        // Without the query in the path: apify-client puts the URL into the error, and a 5xx error is logged.
        const error = new ApifyApiError({ ...response, data, config: { ...response.config, url: stripQuery(url) } }, 1);
        if (error.type === APIFY_ERROR_TYPE_PAGE_NOT_FOUND) await addClosestPaths(error, normalizedPath, params.signal);
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
    // A storage object holds its URL signing key (see apify/ai-team#330). A text body is a JSON string here,
    // with its quotes escaped, so it never matches.
    const json = JSON.stringify(structuredContent);
    const text = redactUrlSigningSecretKey(json);
    return respondOk([text, summary], { structuredContent: text === json ? structuredContent : JSON.parse(text) });
}
