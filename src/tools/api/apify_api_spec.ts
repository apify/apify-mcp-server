import { z } from 'zod';

import { apifyApiOperationsCache } from '../../state.js';
import type { ApiBlockRule } from './apify_api_blocklist.js';
import { API_BLOCK_RULES, applyApiBlocklist } from './apify_api_blocklist.js';

export const APIFY_API_OPENAPI_URL = 'https://docs.apify.com/api/openapi.json';

/** HEAD is left out: it returns no body, and each HEAD operation has a GET twin. */
export const API_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type ApiMethod = (typeof API_METHODS)[number];

/** The API reference has one page per operation, at the operation ID in kebab case. */
const API_DOCS_BASE_URL = 'https://docs.apify.com/api/v2';

export type ApiParameter = {
    name: string;
    in: 'path' | 'query';
    isRequired: boolean;
    description?: string;
    schema?: unknown;
};

export type ApiOperation = {
    /** The spec's key for the operation. Internal: the tools find operations by method and path. */
    operationId: string;
    method: ApiMethod;
    /** Path template, for example `/v2/actors/{actorId}`. */
    path: string;
    summary: string;
    description: string;
    /** The operation's page in the API reference. */
    docsUrl: string;
    tags: string[];
    /** Path and query parameters; header parameters are left out, the tools never send them. */
    parameters: ApiParameter[];
    /** Dereferenced JSON schema of the request body; absent when the operation takes none. */
    requestBody?: { isRequired: boolean; schema: unknown };
};

/** Schema keywords that only cost context. `x-*` vendor extensions are dropped by prefix in `dereference()`. */
const DROPPED_SCHEMA_KEYS: ReadonlySet<string> = new Set(['example', 'examples']);

const openApiOperationValidator = z.object({
    operationId: z.string().min(1),
    summary: z.string().optional(),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
    deprecated: z.boolean().optional(),
    parameters: z.array(z.unknown()).optional(),
    requestBody: z.unknown().optional(),
});

const openApiParameterValidator = z.object({
    name: z.string().min(1),
    in: z.string(),
    required: z.boolean().optional(),
    description: z.string().optional(),
    schema: z.unknown().optional(),
});

const openApiRequestBodyValidator = z.object({
    required: z.boolean().optional(),
    content: z.record(z.string(), z.object({ schema: z.unknown().optional() })),
});

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Walks a local `#/...` reference; `undefined` when it does not resolve. */
function resolveLocalRef(spec: unknown, ref: string): unknown {
    if (!ref.startsWith('#/')) return undefined;
    let node: unknown = spec;
    for (const segment of ref.slice(2).split('/')) {
        if (!isRecord(node)) return undefined;
        node = node[segment];
    }
    return node;
}

/**
 * Resolves local `$ref`s and drops examples and vendor extensions. Property names under `properties`
 * are kept as they are, since a property can be named `example`.
 */
function dereference(node: unknown, spec: unknown, seenRefs: ReadonlySet<string> = new Set()): unknown {
    if (Array.isArray(node)) return node.map((item) => dereference(item, spec, seenRefs));
    if (!isRecord(node)) return node;
    if (typeof node.$ref === 'string') {
        // A reference cycle would recurse forever; the published spec has none.
        if (seenRefs.has(node.$ref)) return {};
        return dereference(resolveLocalRef(spec, node.$ref), spec, new Set([...seenRefs, node.$ref]));
    }
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
        if (DROPPED_SCHEMA_KEYS.has(key) || key.startsWith('x-')) continue;
        result[key] =
            key === 'properties' && isRecord(value)
                ? Object.fromEntries(
                      Object.entries(value).map(([name, schema]) => [name, dereference(schema, spec, seenRefs)]),
                  )
                : dereference(value, spec, seenRefs);
    }
    return result;
}

/** Lowercase words of a text, splitting camelCase, snake_case, kebab-case, and paths. */
function splitWords(text: string): string[] {
    return text
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
}

function parseParameters(rawParameters: unknown[] | undefined, spec: unknown): ApiParameter[] {
    const parameters: ApiParameter[] = [];
    for (const rawParameter of rawParameters ?? []) {
        const parsed = openApiParameterValidator.safeParse(dereference(rawParameter, spec));
        if (!parsed.success) continue;
        const { name, in: location, required, description, schema } = parsed.data;
        if (location !== 'path' && location !== 'query') continue;
        parameters.push({
            name,
            in: location,
            // OpenAPI makes every path parameter required.
            isRequired: location === 'path' || required === true,
            ...(description && { description }),
            ...(schema !== undefined && { schema }),
        });
    }
    return parameters;
}

function parseRequestBody(rawRequestBody: unknown, spec: unknown): ApiOperation['requestBody'] {
    if (rawRequestBody === undefined) return undefined;
    const parsed = openApiRequestBodyValidator.safeParse(dereference(rawRequestBody, spec));
    if (!parsed.success) return undefined;
    const { content, required } = parsed.data;
    // Every body is sent as JSON; the key-value store record operations declare `*/*`.
    const media = content['application/json'] ?? content['*/*'];
    if (!media) return undefined;
    return { isRequired: required === true, schema: media.schema ?? {} };
}

/**
 * Builds the operation index from an OpenAPI document. Deprecated operations, HEAD operations, and anything
 * outside `/v2/` are left out; malformed entries are skipped rather than failing the whole spec. So are the
 * operations and query parameters a rule refuses to the tool that sends the method (`applyApiBlocklist`),
 * such as the `method` query parameter, so no tool that reads the index offers them.
 * It throws when the spec lists no operation.
 */
export function buildApiOperationIndex(
    spec: unknown,
    rules: readonly ApiBlockRule[] = API_BLOCK_RULES,
): Map<string, ApiOperation> {
    const index = new Map<string, ApiOperation>();
    const paths = isRecord(spec) && isRecord(spec.paths) ? spec.paths : {};
    for (const [path, pathItem] of Object.entries(paths)) {
        if (!path.startsWith('/v2/') || !isRecord(pathItem)) continue;
        for (const method of API_METHODS) {
            const parsed = openApiOperationValidator.safeParse(pathItem[method.toLowerCase()]);
            if (!parsed.success || parsed.data.deprecated) continue;
            const { operationId, summary, description, tags, parameters, requestBody } = parsed.data;
            const body = parseRequestBody(requestBody, spec);
            const operation = applyApiBlocklist(
                {
                    operationId,
                    method,
                    path,
                    summary: summary ?? '',
                    description: description ?? '',
                    docsUrl: `${API_DOCS_BASE_URL}/${splitWords(operationId).join('-')}`,
                    tags: tags ?? [],
                    parameters: parseParameters(parameters, spec),
                    ...(body && { requestBody: body }),
                },
                rules,
            );
            if (operation) index.set(operationId, operation);
        }
    }
    if (index.size === 0) throw new Error('the spec lists no /v2/ operations.');
    return index;
}

/** How long the spec download may take; MCP clients stop waiting for a tool call after 60 seconds. */
const SPEC_DOWNLOAD_TIMEOUT_MS = 30_000;

let pendingIndex: Promise<Map<string, ApiOperation>> | undefined;

async function downloadApiOperationIndex(): Promise<Map<string, ApiOperation>> {
    const failure = `Failed to load the Apify API operations from ${APIFY_API_OPENAPI_URL}`;
    // Every session waits on this one download, so a stalled one must not hold them all.
    const response = await fetch(APIFY_API_OPENAPI_URL, { signal: AbortSignal.timeout(SPEC_DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`${failure}: HTTP ${response.status}.`);
    let spec: unknown;
    try {
        spec = await response.json();
    } catch {
        throw new Error(`${failure}: the response is not JSON.`);
    }
    // An index without operations is not cached.
    try {
        return buildApiOperationIndex(spec);
    } catch (error) {
        throw new Error(`${failure}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * The operation index, from the published spec, cached for a day. Concurrent calls share one
 * download. A failed download throws and is not cached, and the next call tries again.
 */
export async function fetchApiOperationIndex(): Promise<Map<string, ApiOperation>> {
    const cached = apifyApiOperationsCache.get(APIFY_API_OPENAPI_URL);
    if (cached) return cached;
    pendingIndex ??= downloadApiOperationIndex()
        .then((index) => {
            apifyApiOperationsCache.set(APIFY_API_OPENAPI_URL, index);
            return index;
        })
        .finally(() => {
            pendingIndex = undefined;
        });
    return pendingIndex;
}

/** Words that tell no operation apart, such as the question words and pronouns that fill the descriptions. */
const SEARCH_STOP_WORDS: ReadonlySet<string> = new Set([
    'a',
    'all',
    'an',
    'and',
    'apify',
    'are',
    'be',
    'can',
    'did',
    'does',
    'for',
    'has',
    'have',
    'how',
    'in',
    'is',
    'its',
    'my',
    'of',
    'on',
    'or',
    'that',
    'the',
    'this',
    'to',
    'what',
    'where',
    'which',
    'who',
    'why',
    'with',
    'you',
    'your',
]);

/** Verbs for what each method does, so a verb the summary does not use, such as rename, still counts. */
const METHOD_VERBS: Record<ApiMethod, readonly string[]> = {
    GET: ['get', 'list', 'read'],
    POST: ['add', 'create', 'push', 'start'],
    PUT: ['update', 'set', 'rename', 'change'],
    PATCH: ['update', 'patch', 'change'],
    DELETE: ['delete', 'remove'],
};

/** A prefix match, or the plural of a word, so `env` finds `environment` and `runs` finds `run`. */
function hasMatchingWord(term: string, words: string[]): boolean {
    return words.some((word) => word.startsWith(term) || term === `${word}s`);
}

/** The same word, or its plural or singular: a prefix match finds too many words in prose, such as endpoint for end. */
function hasWholeWord(term: string, words: string[]): boolean {
    return words.some((word) => word === term || word === `${term}s` || term === `${word}s`);
}

/**
 * Paths that reach a run's own copy of a resource: the default storages and actions of a run or of the
 * last run, and the synchronous runs. A plain ask such as "add items to a dataset" means the storage
 * itself, so these rank lower unless the query is about runs or tasks.
 */
const RUN_SCOPED_PATH_REGEX = /^\/v2\/actor-runs\/\{runId\}\/|\/runs\/last\/|\/run-sync/;
const RUN_SCOPE_TERMS: ReadonlySet<string> = new Set(['run', 'runs', 'last', 'task', 'tasks', 'sync']);
const RUN_SCOPED_PENALTY = 2;

/**
 * Operations matching the query's keywords, best first, scored by where each keyword is found. A verb for
 * the method alone does not match. The description counts only for keywords no operation's name has, and
 * only with two or more of them, since one word alone is in too many descriptions. Ties go to the shorter path.
 */
export function searchApiOperations(index: Map<string, ApiOperation>, query: string, limit: number): ApiOperation[] {
    // One-letter terms, such as the s of "run's", match too many words.
    const terms = [...new Set(splitWords(query))].filter((term) => term.length > 1 && !SEARCH_STOP_WORDS.has(term));
    const isAboutRuns = terms.some((term) => RUN_SCOPE_TERMS.has(term));
    const nameWords = [...index.values()].flatMap((operation) =>
        splitWords(`${operation.summary} ${operation.operationId} ${operation.path} ${operation.tags.join(' ')}`),
    );
    // A keyword a name has is left to the names: a description also lists fields, such as the
    // maxMonthlyUsageUsd of Update limits, which would rank that operation above Get limits.
    const descriptionTerms = terms.filter((term) => !hasMatchingWord(term, nameWords));
    const scored: { operation: ApiOperation; score: number }[] = [];
    for (const operation of index.values()) {
        const summaryWords = splitWords(operation.summary);
        const idWords = splitWords(`${operation.operationId} ${operation.path}`);
        const tagWords = splitWords(operation.tags.join(' '));
        const descriptionWords = splitWords(operation.description);
        const verbs = METHOD_VERBS[operation.method];
        let score = 0;
        let verbScore = 0;
        let descriptionHits = 0;
        for (const term of terms) {
            if (hasMatchingWord(term, summaryWords)) score += 3;
            else if (hasMatchingWord(term, idWords)) score += 2;
            else if (hasMatchingWord(term, tagWords)) score += 1;
            else if (verbs.includes(term)) verbScore += 2;
            else if (descriptionTerms.includes(term) && hasWholeWord(term, descriptionWords)) descriptionHits += 1;
        }
        if (descriptionHits >= 2) score += 2 * descriptionHits;
        if (score === 0) continue;
        const penalty = !isAboutRuns && RUN_SCOPED_PATH_REGEX.test(operation.path) ? RUN_SCOPED_PENALTY : 0;
        scored.push({ operation, score: score + verbScore - penalty });
    }
    return scored
        .sort((a, b) => b.score - a.score || a.operation.path.length - b.operation.path.length)
        .slice(0, limit)
        .map(({ operation }) => operation);
}
