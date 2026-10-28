import { z } from 'zod';

import { apifyApiOperationsCache } from '../../state.js';
import type { ApiBlockRule } from './apify_api_blocklist.js';
import { isEndpointBlocked } from './apify_api_blocklist.js';

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
    /** Kept only for Actor schemas, see `DereferenceContext`. */
    example?: unknown;
    examples?: unknown;
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
    requestBody?: { isRequired: boolean; schema: unknown; example?: unknown; examples?: unknown };
};

/**
 * What `dereference()` resolves against. The Apify spec drops examples; an Actor schema keeps them, since the
 * creator's examples show a valid call. `budget` bounds the work on an untrusted schema: it is mutated, and
 * `dereference()` throws `DereferenceBudgetError` when it runs out.
 */
export type DereferenceContext = {
    spec: unknown;
    shouldKeepExamples?: boolean;
    budget?: { remainingBytes: number };
};

export class DereferenceBudgetError extends Error {}

/** Real schemas nest a few dozen levels; past this, an untrusted schema could overflow the stack. */
const MAX_BUDGETED_DEPTH = 256;

/** The references being expanded, shared by the whole walk, and the nesting depth of the current node. */
type DereferenceWalk = { seenRefs: Set<string>; depth: number };

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
    example: z.unknown().optional(),
    examples: z.unknown().optional(),
});

const openApiRequestBodyValidator = z.object({
    required: z.boolean().optional(),
    content: z.record(
        z.string(),
        z.object({ schema: z.unknown().optional(), example: z.unknown().optional(), examples: z.unknown().optional() }),
    ),
});

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Walks a local `#/...` reference; `undefined` when it does not resolve. */
export function resolveLocalRef(spec: unknown, ref: string): unknown {
    if (!ref.startsWith('#/')) return undefined;
    let node: unknown = spec;
    for (const segment of ref.slice(2).split('/')) {
        const key = segment.replaceAll('~1', '/').replaceAll('~0', '~');
        if (typeof node !== 'object' || node === null || !Object.hasOwn(node, key)) return undefined;
        node = (node as Record<string, unknown>)[key];
    }
    return node;
}

/**
 * Resolves local `$ref`s and drops vendor extensions, and examples unless the context keeps them; kept examples
 * are data and stay as written. A reference that does not resolve stays as written. Property names under
 * `properties` are kept as they are, since a property can be named `example`.
 */
function dereference(
    node: unknown,
    context: DereferenceContext,
    walk: DereferenceWalk = { seenRefs: new Set(), depth: 0 },
): unknown {
    if (!Array.isArray(node) && !isRecord(node)) return node;
    if (context.budget && walk.depth >= MAX_BUDGETED_DEPTH) throw new DereferenceBudgetError();
    const child = { seenRefs: walk.seenRefs, depth: walk.depth + 1 };
    if (Array.isArray(node)) return node.map((item) => dereference(item, context, child));
    if (typeof node.$ref === 'string') {
        const ref = node.$ref;
        // A reference cycle would recurse forever; a cycle renders as an empty schema.
        if (walk.seenRefs.has(ref)) return {};
        const target = resolveLocalRef(context.spec, ref);
        if (target === undefined) return { $ref: ref };
        chargeExpansion(target, context);
        walk.seenRefs.add(ref);
        try {
            return dereference(target, context, child);
        } finally {
            walk.seenRefs.delete(ref);
        }
    }
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
        if (key.startsWith('x-')) continue;
        if (DROPPED_SCHEMA_KEYS.has(key)) {
            // A record under `examples` is an OpenAPI examples map; a JSON Schema `examples` is an array.
            const isExamplesMap = key === 'examples' && isRecord(value);
            if (context.shouldKeepExamples) result[key] = isExamplesMap ? resolveExamplesMap(value, context) : value;
            continue;
        }
        result[key] =
            key === 'properties' && isRecord(value)
                ? Object.fromEntries(
                      Object.entries(value).map(([name, schema]) => [name, dereference(schema, context, child)]),
                  )
                : dereference(value, context, child);
    }
    return result;
}

/** Charges the size of a reference's target to the budget, if there is one. */
function chargeExpansion(target: unknown, context: DereferenceContext): void {
    if (!context.budget) return;
    // Shared references can expand exponentially, so each expansion costs the size of its target.
    context.budget.remainingBytes -= Buffer.byteLength(JSON.stringify(target));
    if (context.budget.remainingBytes < 0) throw new DereferenceBudgetError();
}

/** An OpenAPI examples map, each local Reference Object replaced by its target as written; the rest as written. */
function resolveExamplesMap(examples: Record<string, unknown>, context: DereferenceContext): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};
    for (const [name, example] of Object.entries(examples)) {
        const target =
            isRecord(example) && typeof example.$ref === 'string'
                ? resolveLocalRef(context.spec, example.$ref)
                : undefined;
        if (target !== undefined) chargeExpansion(target, context);
        resolved[name] = target === undefined ? example : target;
    }
    return resolved;
}

/** `application/json`, also with parameters such as `; charset=utf-8`, or a `+json` type such as `application/vnd.api+json`. */
function isJsonMediaType(mediaType: string): boolean {
    const base = mediaType.split(';')[0].trim().toLowerCase();
    return base === 'application/json' || base.endsWith('+json');
}

/** Lowercase words of a text, splitting camelCase, snake_case, kebab-case, and paths. */
function splitWords(text: string): string[] {
    return text
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
}

export function parseParameters(rawParameters: unknown[] | undefined, context: DereferenceContext): ApiParameter[] {
    const parameters: ApiParameter[] = [];
    for (const rawParameter of rawParameters ?? []) {
        const parsed = openApiParameterValidator.safeParse(dereference(rawParameter, context));
        if (!parsed.success) continue;
        const { name, in: location, required, description, schema, example, examples } = parsed.data;
        if (location !== 'path' && location !== 'query') continue;
        parameters.push({
            name,
            in: location,
            // OpenAPI makes every path parameter required.
            isRequired: location === 'path' || required === true,
            ...(description && { description }),
            ...(schema !== undefined && { schema }),
            ...(example !== undefined && { example }),
            ...(examples !== undefined && { examples }),
        });
    }
    return parameters;
}

export function parseRequestBody(rawRequestBody: unknown, context: DereferenceContext): ApiOperation['requestBody'] {
    if (rawRequestBody === undefined) return undefined;
    const parsed = openApiRequestBodyValidator.safeParse(dereference(rawRequestBody, context));
    if (!parsed.success) return undefined;
    const { content, required } = parsed.data;
    // Every body is sent as JSON; the key-value store record operations declare `*/*`.
    const media = content['application/json'] ?? content[Object.keys(content).find(isJsonMediaType) ?? '*/*'];
    if (!media) return undefined;
    const { schema, example, examples } = media;
    return {
        isRequired: required === true,
        schema: schema ?? {},
        ...(example !== undefined && { example }),
        ...(examples !== undefined && { examples }),
    };
}

/**
 * Builds the operation index from an OpenAPI document. Deprecated operations, HEAD operations, operations a
 * blocklist rule matches (`API_BLOCK_RULES`), and anything outside `/v2/` are left out, so no tool that reads
 * the index offers them; malformed entries are skipped rather than failing the whole spec.
 * It throws when the spec lists no operation.
 */
export function buildApiOperationIndex(spec: unknown, rules?: readonly ApiBlockRule[]): Map<string, ApiOperation> {
    const index = new Map<string, ApiOperation>();
    const paths = isRecord(spec) && isRecord(spec.paths) ? spec.paths : {};
    for (const [path, pathItem] of Object.entries(paths)) {
        if (!path.startsWith('/v2/') || !isRecord(pathItem)) continue;
        for (const method of API_METHODS) {
            const parsed = openApiOperationValidator.safeParse(pathItem[method.toLowerCase()]);
            if (!parsed.success || parsed.data.deprecated || isEndpointBlocked(method, path, rules)) continue;
            const { operationId, summary, description, tags, parameters, requestBody } = parsed.data;
            const body = parseRequestBody(requestBody, { spec });
            index.set(operationId, {
                operationId,
                method,
                path,
                summary: summary ?? '',
                description: description ?? '',
                docsUrl: `${API_DOCS_BASE_URL}/${splitWords(operationId).join('-')}`,
                tags: tags ?? [],
                parameters: parseParameters(parameters, { spec }),
                ...(body && { requestBody: body }),
            });
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
