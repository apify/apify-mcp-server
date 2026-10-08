import type { HelperToolName } from '../../const.js';
import { HELPER_TOOLS } from '../../const.js';
import type { ApiMethod, ApiParameter } from './apify_api_spec.js';

/** The API tools that send requests, the ones a rule refuses calls in. */
export type ApiCallToolName = typeof HELPER_TOOLS.API_READ | typeof HELPER_TOOLS.API_WRITE;

type ApiBlockRuleBase = {
    /** Why the call is refused, shown to the agent. */
    reason: string;
    /** A tool to call instead, named only when the session has it and it is not the refusing tool. */
    suggestedToolName?: HelperToolName;
};

/** Matches a query parameter, in `query` or in a query string written into the path, by name. */
export type ApiQueryParamBlockRule = ApiBlockRuleBase & {
    queryParam: string;
    /** The tools that refuse a call the rule matches. */
    toolNames: readonly ApiCallToolName[];
};

/**
 * Matches operations: HTTP methods and a path template as the spec writes it, such as `/v2/actors/{actorId}`.
 * Each method is refused in the tool that sends it (`getApiCallToolName`).
 */
export type ApiOperationBlockRule = ApiBlockRuleBase & {
    operation: { methods: readonly ApiMethod[]; path: `/v2/${string}` };
};

export type ApiBlockRule = ApiQueryParamBlockRule | ApiOperationBlockRule;

/** What the API tools refuse to send. The operation index leaves the same out, so search and details never offer it. */
export const API_BLOCK_RULES: readonly ApiBlockRule[] = [];

/** The tool that sends a method: the read tool sends only a GET, and the write tool every other method. */
export function getApiCallToolName(method: ApiMethod): ApiCallToolName {
    return method === 'GET' ? HELPER_TOOLS.API_READ : HELPER_TOOLS.API_WRITE;
}

/**
 * A text with each `%XX` escape decoded to that byte as a character. Unlike `decodeURIComponent`, it never
 * throws, so a malformed escape elsewhere in the text cannot hide a name.
 */
function decodeEscapes(text: string): string {
    return text.replace(/%([0-9a-f]{2})/gi, (_escape, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/**
 * The top-level name the API's query parser (qs, as Express runs it) reads from a query parameter name, or a
 * broader one: decoded, in lowercase, and without brackets, since `method[]`, `method[0]`, and `[method]` all
 * reach the API as `method`.
 */
function extractQueryParamRoot(name: string): string {
    const decodedName = decodeEscapes(name).toLowerCase();
    return /^\[([^[\]]*)\]/.exec(decodedName)?.[1] ?? decodedName.split('[')[0];
}

function isBlockedQueryParam(name: string, rule: ApiQueryParamBlockRule): boolean {
    return extractQueryParamRoot(name) === rule.queryParam.toLowerCase();
}

/** A path template segment that is a parameter, such as `{actorId}`. */
export const PATH_PARAMETER_SEGMENT_REGEX = /^\{[^{}]+\}$/;

/**
 * The segments of a path as the API routes it: split first and then decoded one by one, so an escaped slash
 * stays in its segment; in lowercase; without the empty segments of a trailing slash, or of a doubled one in
 * case anything before the router merges it; and with the legacy `acts` prefix read as `actors`, the one the
 * spec lists.
 */
function splitRoutePath(path: string): string[] {
    const segments = path
        .split('/')
        .filter(Boolean)
        .map((segment) => decodeEscapes(segment).toLowerCase());
    if (segments[0] === 'v2' && segments[1] === 'acts') segments[1] = 'actors';
    return segments;
}

/**
 * Whether the API routes a path, with values or as a spec template, to the operation of the rule. Without a
 * method, the path alone decides.
 */
function isBlockedOperation(method: ApiMethod | undefined, path: string, rule: ApiOperationBlockRule): boolean {
    if (method !== undefined && !rule.operation.methods.includes(method)) return false;
    const templateSegments = splitRoutePath(rule.operation.path);
    const segments = splitRoutePath(path);
    if (segments.length !== templateSegments.length) return false;
    // A parameter matches one segment, never an empty one: the split drops those.
    return templateSegments.every(
        (templateSegment, position) =>
            PATH_PARAMETER_SEGMENT_REGEX.test(templateSegment) || segments[position] === templateSegment,
    );
}

/** A normalized path parsed as the request URL is. Any origin will do; only the path and the query are checked. */
function parseRequestUrl(normalizedPath: string): URL {
    return new URL(`https://api.invalid/v2/${normalizedPath}`);
}

/** The reason of a rule, with the tool it suggests when the session has it and it is not the refusing tool. */
function formatRefusal(
    { reason, suggestedToolName }: ApiBlockRule,
    toolName: ApiCallToolName | undefined,
    loadedToolNames: readonly string[],
): string {
    const canSuggest =
        suggestedToolName !== undefined &&
        suggestedToolName !== toolName &&
        loadedToolNames.includes(suggestedToolName);
    return canSuggest ? `${reason} Use ${suggestedToolName} instead.` : reason;
}

/**
 * Why a rule refuses a call, or `undefined` when none does. The path is parsed as the request URL is: dot
 * segments resolved, a backslash read as a slash, tabs and newlines dropped. The match is fail-closed: a
 * path matches in any letter case and with a trailing or doubled slash, and a query name matches decoded, in
 * any letter case, and with brackets. Without a method (the write tool checks before it chooses one), an
 * operation rule with a method the tool sends refuses the path; `callApi` checks again with the method.
 */
export function validateApiBlocklist(
    {
        toolName,
        method,
        normalizedPath,
        query,
        loadedToolNames,
    }: {
        toolName: ApiCallToolName;
        method: ApiMethod | undefined;
        /** The path as `normalizeApiPath` returns it, with any query string written into it. */
        normalizedPath: string;
        query?: Record<string, unknown>;
        loadedToolNames: readonly string[];
    },
    rules: readonly ApiBlockRule[] = API_BLOCK_RULES,
): string | undefined {
    const { pathname, searchParams } = parseRequestUrl(normalizedPath);
    const queryNames = [...searchParams.keys(), ...Object.keys(query ?? {})];
    const rule = rules.find((candidate) =>
        'queryParam' in candidate
            ? candidate.toolNames.includes(toolName) && queryNames.some((name) => isBlockedQueryParam(name, candidate))
            : candidate.operation.methods.some((ruleMethod) => getApiCallToolName(ruleMethod) === toolName) &&
              isBlockedOperation(method, pathname, candidate),
    );
    return rule && formatRefusal(rule, toolName, loadedToolNames);
}

/**
 * Why the API tools refuse calls to a path in a method, or `undefined` when no operation rule matches it;
 * without a method, the path alone decides. For a tool that reads the index instead of calling, such as
 * apify-api-details: the index leaves out what a rule refuses, so a lookup there could match a path next
 * to it or say the method is missing. The path is parsed as in `validateApiBlocklist`.
 */
export function validateApiPathBlocklist(
    {
        normalizedPath,
        method,
        loadedToolNames,
    }: {
        /** The path as `normalizeApiPath` returns it. */
        normalizedPath: string;
        method?: ApiMethod;
        loadedToolNames: readonly string[];
    },
    rules: readonly ApiBlockRule[] = API_BLOCK_RULES,
): string | undefined {
    const { pathname } = parseRequestUrl(normalizedPath);
    const rule = rules.find((candidate) => 'operation' in candidate && isBlockedOperation(method, pathname, candidate));
    return rule && formatRefusal(rule, undefined, loadedToolNames);
}

/**
 * An operation of the spec as the API tools offer it: `undefined` when a rule refuses it to the tool that sends
 * its method, and otherwise without the query parameters a rule refuses to that tool.
 */
export function applyApiBlocklist<TOperation extends { method: ApiMethod; path: string; parameters: ApiParameter[] }>(
    operation: TOperation,
    rules: readonly ApiBlockRule[] = API_BLOCK_RULES,
): TOperation | undefined {
    const isBlocked = rules.some(
        (rule) => 'operation' in rule && isBlockedOperation(operation.method, operation.path, rule),
    );
    if (isBlocked) return undefined;
    const toolName = getApiCallToolName(operation.method);
    const parameters = operation.parameters.filter(
        (parameter) =>
            parameter.in !== 'query' ||
            !rules.some(
                (rule) =>
                    'queryParam' in rule &&
                    rule.toolNames.includes(toolName) &&
                    isBlockedQueryParam(parameter.name, rule),
            ),
    );
    return { ...operation, parameters };
}
