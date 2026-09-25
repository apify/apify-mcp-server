import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { z } from 'zod';

import type { ApifyClient } from '../../apify_client.js';
import { HELPER_TOOLS, MAX_INLINE_BYTES } from '../../const.js';
import { isMaxContentLengthAbort } from '../../resources/api_resources.js';
import type { ToolResponse } from '../../utils/mcp.js';
import { respondOk, respondUserError } from '../../utils/mcp.js';
import { WAIT_SECS_MAX } from '../actors/actor_run_response.js';
import type { ApiAccess, ApiOperation } from './apify_api_spec.js';
import { API_ACCESS } from './apify_api_spec.js';

/** Input fields the read and write tools share. */
export const apiCallArgsShape = {
    operationId: z
        .string()
        .min(1)
        .describe('The operation ID, for example actor_get. Operation IDs are case-sensitive.'),
    pathParams: z
        .record(z.string(), z.string())
        .optional()
        .describe(
            'Values for the placeholders in the operation path, by name, for example {"actorId": "apify~web-scraper"}. ' +
                'An Actor, task or storage is given by its ID or as username~name.',
        ),
    query: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe(
            'Query parameters, by name, for example {"limit": 10}. Only parameters the operation declares are accepted.',
        ),
};

export type ApiCallParams = {
    query?: Record<string, string | number | boolean>;
    /** Aborts the request when the client cancels the tool call. */
    signal?: AbortSignal;
};

/** The not-found text, naming the search tool only when the session has it. */
export function formatOperationNotFoundMessage(operationId: string, loadedToolNames: readonly string[]): string {
    const findIt = loadedToolNames.includes(HELPER_TOOLS.API_SEARCH) ? ` Find it with ${HELPER_TOOLS.API_SEARCH}.` : '';
    return `API operation ${operationId} not found.${findIt}`;
}

/** The operation a tool with the given access may call, or the reason it may not. */
export function resolveOperationToCall(
    index: Map<string, ApiOperation>,
    operationId: string,
    access: Exclude<ApiAccess, 'unavailable'>,
    loadedToolNames: readonly string[],
): { operation: ApiOperation } | { error: string } {
    const operation = index.get(operationId);
    if (!operation) return { error: formatOperationNotFoundMessage(operationId, loadedToolNames) };
    if (operation.access === API_ACCESS.UNAVAILABLE) {
        return { error: `The API tools do not call ${operationId}. ${operation.unavailableReason}` };
    }
    if (operation.access !== access) {
        return {
            error: `${operationId} is a ${operation.method} operation with ${operation.access} access; this tool has ${access} access.`,
        };
    }
    return { operation };
}

const PATH_PARAMETER_REGEX = /\{([^}]+)\}/g;

/** Fills the operation's path template; returns the reason instead when the parameters do not fit it. */
export function buildRequestPath(
    operation: ApiOperation,
    pathParams: Record<string, string> = {},
): { path: string } | { error: string } {
    const names = [...operation.path.matchAll(PATH_PARAMETER_REGEX)].map((match) => match[1]);
    const unknownNames = Object.keys(pathParams).filter((name) => !names.includes(name));
    if (unknownNames.length > 0) {
        return {
            error: `${operation.operationId} has no path parameter ${unknownNames.join(', ')}. Its path is ${operation.path}.`,
        };
    }
    let { path } = operation;
    for (const name of names) {
        const value = pathParams[name];
        if (!value) return { error: `Missing path parameter ${name}. The path is ${operation.path}.` };
        // Encoded, `.` and `..` stay as they are and would move the request to another route.
        if (value === '.' || value === '..') return { error: `Path parameter ${name} cannot be "${value}".` };
        // The API takes username~name; apify-client swaps the first slash the same way.
        path = path.replace(`{${name}}`, encodeURIComponent(value.replace('/', '~')));
    }
    return { path };
}

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
            `${operation.operationId} does not take the query parameter ${unknownNames.join(', ')}. ` +
            `It takes: ${[...declaredNames].join(', ') || 'none'}.`
        );
    }
    const missingNames = declared
        .filter((parameter) => parameter.isRequired && query[parameter.name] === undefined)
        .map((parameter) => parameter.name);
    if (missingNames.length > 0) return `Missing required query parameter ${missingNames.join(', ')}.`;
    // Same cap as the run and build tools: MCP clients stop waiting for a tool call after 60 seconds.
    if (query.waitForFinish !== undefined && Number(query.waitForFinish) > WAIT_SECS_MAX) {
        return `waitForFinish can be at most ${WAIT_SECS_MAX} seconds. Call the operation again to keep waiting.`;
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
 * Sends one request to a filled-in operation path and returns the response body.
 *
 * It goes through the client's axios instance, not `httpClient.call()`, like `readApiResource`: one
 * attempt and no retries, since a retried write could apply twice, and apify-client would retry the
 * `maxContentLength` abort as a network error. The instance still adds the token and the request-origin
 * and payment headers, and parses JSON and text bodies. A non-2xx response is thrown as the
 * `ApifyApiError` apify-client itself builds, so it gets the usual tool error text and telemetry.
 */
export async function callApiOperation(
    client: ApifyClient,
    operation: ApiOperation,
    path: string,
    params: ApiCallParams,
): Promise<ToolResponse> {
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
        if (isMaxContentLengthAbort(error)) return respondUserError(formatOversizeMessage(operation, path));
        throw error;
    }
    if (response.status >= 300) throw new ApifyApiError(response, 1);

    const contentTypeHeader = response.headers['content-type'];
    const contentType = typeof contentTypeHeader === 'string' ? contentTypeHeader : undefined;
    // apify-client parses JSON and text bodies; a binary body stays a Buffer and is not returned.
    const isBinary = Buffer.isBuffer(response.data);
    const structuredContent = {
        operationId: operation.operationId,
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
