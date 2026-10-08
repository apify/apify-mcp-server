import type { HelperToolName } from '../../const.js';
import { HELPER_TOOLS } from '../../const.js';
import type { ApiMethod } from './apify_api_spec.js';

/** A request the API tools refuse to send. */
export type ApiBlockRule = {
    /** A query parameter, refused in every call, or one operation: a method and a spec path template. */
    match: { queryParam: string } | { method: ApiMethod; path: `/v2/${string}` };
    /** Why the call is refused, shown to the agent. */
    reason: string;
    /** Tools to use instead, each named only when the session has it and it is not the refusing tool. */
    suggestedToolNames?: readonly HelperToolName[];
};

const SYNC_RUN_GET_REASON =
    'A GET to the synchronous run endpoints starts a paid run, as a POST does, so the API tools do not send it.';

/** What the API tools refuse to send. The operation index leaves out each operation a rule matches. */
export const API_BLOCK_RULES: readonly ApiBlockRule[] = [
    {
        // A GET with method=DELETE deletes, so the read tool could write; see apify/apify-mcp-server#1501.
        match: { queryParam: 'method' },
        reason:
            'The API tools do not send the method query parameter: the API would take it as the HTTP method ' +
            'of the request.',
        suggestedToolNames: [HELPER_TOOLS.API_WRITE],
    },
    // A GET to a synchronous run endpoint starts a paid run, so the read tool would not be read-only; the write
    // tool sends the POST. See apify/apify-mcp-server#1502.
    {
        match: { method: 'GET', path: '/v2/actors/{actorId}/run-sync' },
        reason: SYNC_RUN_GET_REASON,
        suggestedToolNames: [HELPER_TOOLS.ACTOR_CALL, HELPER_TOOLS.API_WRITE],
    },
    {
        match: { method: 'GET', path: '/v2/actors/{actorId}/run-sync-get-dataset-items' },
        reason: SYNC_RUN_GET_REASON,
        suggestedToolNames: [HELPER_TOOLS.ACTOR_CALL, HELPER_TOOLS.API_WRITE],
    },
    // call-actor runs an Actor, not a saved task.
    {
        match: { method: 'GET', path: '/v2/actor-tasks/{actorTaskId}/run-sync' },
        reason: SYNC_RUN_GET_REASON,
        suggestedToolNames: [HELPER_TOOLS.API_WRITE],
    },
    {
        match: { method: 'GET', path: '/v2/actor-tasks/{actorTaskId}/run-sync-get-dataset-items' },
        reason: SYNC_RUN_GET_REASON,
        suggestedToolNames: [HELPER_TOOLS.API_WRITE],
    },
];

/** Decodes each `%XX` escape. Unlike `decodeURIComponent`, it never throws, so a malformed escape hides nothing. */
function decodeEscapes(text: string): string {
    return text.replace(/%([0-9a-f]{2})/gi, (_escape, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/**
 * A query parameter name, decoded and in lowercase (both fail-closed, beyond what the API reads), without the
 * brackets the API's query parser (qs, run by Express) reads through: qs reads `method[]`, `method[0]`, and
 * `[method]` all as `method`.
 */
function extractQueryParamName(name: string): string {
    const decodedName = decodeEscapes(name).toLowerCase();
    return /^\[([^[\]]*)\]/.exec(decodedName)?.[1] ?? decodedName.split('[')[0];
}

/**
 * A path's segments, matched fail-closed: in lowercase, each decoded, without empty segments (a trailing or
 * doubled slash), and with the legacy `acts` prefix read as `actors`. Split before decoding, as the API's router
 * does, so the escaped slash in `apify%2Fhello-world` stays in its segment.
 */
function splitRoutePath(path: string): string[] {
    const segments = path
        .split('/')
        .filter(Boolean)
        .map((segment) => decodeEscapes(segment).toLowerCase());
    if (segments[0] === 'v2' && segments[1] === 'acts') segments[1] = 'actors';
    return segments;
}

/** Whether an operation rule matches a method and a path, with values or a spec template. */
function isOperationMatch(match: { method: ApiMethod; path: string }, method: ApiMethod, path: string): boolean {
    if (match.method !== method) return false;
    const segments = splitRoutePath(path);
    const templateSegments = splitRoutePath(match.path);
    return (
        segments.length === templateSegments.length &&
        templateSegments.every((segment, position) => segment.startsWith('{') || segment === segments[position])
    );
}

/**
 * Why a rule refuses a request, or `undefined` when none does. It matches fail-closed: a path in any letter
 * case, decoded segment by segment, and with trailing or doubled slashes; a query parameter name decoded, in
 * any letter case, and with brackets.
 */
export function validateApiBlocklist(
    request: {
        method: ApiMethod;
        /** The path as `normalizeApiPath` returns it, with any query string written into it. */
        normalizedPath: string;
        query?: Record<string, unknown>;
        loadedToolNames: readonly string[];
    },
    rules = API_BLOCK_RULES,
): string | undefined {
    const { method, normalizedPath, query = {}, loadedToolNames } = request;
    // Parsed as the request URL is: dot segments resolved, a backslash read as a slash, tabs and newlines dropped.
    const { pathname, searchParams } = new URL(`https://api.invalid/v2/${normalizedPath}`);
    const queryNames = [...searchParams.keys(), ...Object.keys(query)].map(extractQueryParamName);
    const rule = rules.find(({ match }) =>
        'queryParam' in match
            ? queryNames.includes(match.queryParam.toLowerCase())
            : isOperationMatch(match, method, pathname),
    );
    if (!rule) return undefined;
    // The read tool sends a GET, and the write tool every other method.
    const refusingToolName = method === 'GET' ? HELPER_TOOLS.API_READ : HELPER_TOOLS.API_WRITE;
    const toolNames = (rule.suggestedToolNames ?? []).filter(
        (name) => name !== refusingToolName && loadedToolNames.includes(name),
    );
    return toolNames.length > 0 ? `${rule.reason} Use ${toolNames.join(' or ')} instead.` : rule.reason;
}

/** Whether a rule matches an operation of the spec, given by its method and path template. */
export function isApiOperationBlocked(method: ApiMethod, path: string, rules = API_BLOCK_RULES): boolean {
    return rules.some(({ match }) => 'path' in match && isOperationMatch(match, method, path));
}
