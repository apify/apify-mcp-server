import type { HelperToolName } from '../../const.js';
import { HELPER_TOOLS } from '../../const.js';
import { normalizeApiPath } from './apify_api_request.js';
import type { ApiMethod } from './apify_api_spec.js';

/** A method and a spec path template, written with or without the `/v2` prefix. */
export type ApiEndpointRule = { method: ApiMethod; path: string };

/** A query parameter name, refused in every call. */
export type ApiQueryRule = { queryParam: string };

/** A request the API tools refuse to send. */
export type ApiBlockRule = {
    match: ApiEndpointRule | ApiQueryRule;
    /** Why the call is refused, shown to the agent. */
    reason: string;
    /** Tools to use instead, each named only when the session has it and it is not the refusing tool. */
    suggestedToolNames?: readonly HelperToolName[];
};

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
 * A path's segments, matched fail-closed: without the leading slash and `v2/` prefix (`normalizeApiPath`), in
 * lowercase, each decoded, without empty segments (a trailing or doubled slash), and with the legacy `acts` prefix
 * read as `actors`. Split before decoding, as the API's router does, so the escaped slash in `apify%2Fhello-world`
 * stays in its segment.
 */
function splitRoutePath(path: string): string[] {
    const segments = normalizeApiPath(path)
        .split('/')
        .filter(Boolean)
        .map((segment) => decodeEscapes(segment).toLowerCase());
    if (segments[0] === 'acts') segments[0] = 'actors';
    return segments;
}

/** Whether an endpoint rule matches a method and a path, with values or a spec template. */
function isEndpointMatch(rule: ApiEndpointRule, method: ApiMethod, path: string): boolean {
    if (rule.method !== method) return false;
    const segments = splitRoutePath(path);
    const templateSegments = splitRoutePath(rule.path);
    return (
        segments.length === templateSegments.length &&
        templateSegments.every((segment, position) => segment.startsWith('{') || segment === segments[position])
    );
}

/** Whether a query rule matches one of the query parameter names, as `extractQueryParamName` returns them. */
function isQueryMatch(rule: ApiQueryRule, queryNames: readonly string[]): boolean {
    return queryNames.includes(rule.queryParam.toLowerCase());
}

/** Whether a rule matches a request: an endpoint rule by its method and path, a query rule by its query names. */
function isRuleMatch(
    { match }: ApiBlockRule,
    request: { method: ApiMethod; path: string; queryNames: readonly string[] },
): boolean {
    return 'queryParam' in match
        ? isQueryMatch(match, request.queryNames)
        : isEndpointMatch(match, request.method, request.path);
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
    // A path that climbs out of /v2/ reaches no route the rules are written for.
    if (!pathname.startsWith('/v2/')) {
        return 'The path leaves /v2/ once its dot segments are resolved; the API tools call only paths under /v2/.';
    }
    const queryNames = [...searchParams.keys(), ...Object.keys(query)].map(extractQueryParamName);
    const rule = rules.find((candidate) => isRuleMatch(candidate, { method, path: pathname, queryNames }));
    if (!rule) return undefined;
    // The read tool sends a GET, and the write tool every other method.
    const refusingToolName = method === 'GET' ? HELPER_TOOLS.API_READ : HELPER_TOOLS.API_WRITE;
    const toolNames = (rule.suggestedToolNames ?? []).filter(
        (name) => name !== refusingToolName && loadedToolNames.includes(name),
    );
    return toolNames.length > 0 ? `${rule.reason} Use ${toolNames.join(' or ')} instead.` : rule.reason;
}

/**
 * Whether a rule matches an endpoint of the spec, given by its method and path template. The spec gives no query
 * values, so no query rule matches.
 */
export function isEndpointBlocked(method: ApiMethod, path: string, rules = API_BLOCK_RULES): boolean {
    return rules.some((rule) => isRuleMatch(rule, { method, path, queryNames: [] }));
}
