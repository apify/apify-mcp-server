import { z } from 'zod';

import { apifyApiOperationsCache } from '../../state.js';

/** The published Apify API spec: the only list of operations the API tools call. */
export const APIFY_API_OPENAPI_URL = 'https://docs.apify.com/api/openapi.json';

export const API_ACCESS = {
    READ: 'read',
    WRITE: 'write',
    UNAVAILABLE: 'unavailable',
} as const;
export type ApiAccess = (typeof API_ACCESS)[keyof typeof API_ACCESS];

/** HEAD is left out: it returns no body, and each HEAD operation has a GET twin. */
const INDEXED_METHODS = ['GET', 'POST', 'PUT', 'DELETE'] as const;
type ApiMethod = (typeof INDEXED_METHODS)[number];

export type ApiParameter = {
    name: string;
    in: 'path' | 'query';
    isRequired: boolean;
    description?: string;
    schema?: unknown;
};

export type ApiOperation = {
    operationId: string;
    method: ApiMethod;
    /** Path template, for example `/v2/actors/{actorId}`. */
    path: string;
    summary: string;
    description: string;
    tags: string[];
    /** Path and query parameters; header parameters are left out, the tools never send them. */
    parameters: ApiParameter[];
    /** Dereferenced JSON schema of the request body; absent when the operation takes none. */
    requestBody?: { isRequired: boolean; schema: unknown };
    /** Top-level body fields the write tool refuses for this operation. */
    refusedBodyFields: string[];
    access: ApiAccess;
    /** Why the API tools do not call the operation; set exactly when `access` is unavailable. */
    unavailableReason?: string;
};

const DELETE_REASON =
    'Deletion cannot be undone, so the API tools do not delete. The user can delete it in Apify Console.';
const SYNC_RUN_REASON =
    'It waits up to 300 seconds for the run to finish, longer than MCP clients wait for a tool call. ' +
    'Start the run with the asynchronous run operation instead.';

/** Synchronous run paths. Some are GET, but every one of them starts a paid run. */
const SYNC_RUN_PATH_REGEX = /\/run-sync(-get-dataset-items)?$/;

/** Operations the API tools refuse by ID, with the reason they report. */
const UNAVAILABLE_OPERATION_REASONS: ReadonlyMap<string, string> = new Map([
    ['users_me_limits_put', "It changes the account's spending limits. The user can change them in Apify Console."],
    ['PostChargeRun', 'It charges the user of a pay-per-event run. Only the Actor itself charges for its events.'],
]);

/**
 * Body fields that publish an Actor or task, change its pricing or permissions, or change who can read
 * a storage. They are refused only where the operation's schema declares them: a free-form body, such
 * as a key-value store record, can carry the same names as plain data.
 */
export const REFUSED_BODY_FIELDS: ReadonlySet<string> = new Set([
    'isPublic',
    'pricingInfos',
    'actorPermissionLevel',
    'generalAccess',
]);

/** Schema keywords that only cost context: examples and the docs' vendor extensions (`x-*`). */
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

/** Property names a dereferenced schema declares at its top level, including through `allOf`/`anyOf`/`oneOf`. */
function extractTopLevelPropertyNames(schema: unknown): Set<string> {
    if (!isRecord(schema)) return new Set();
    const names = new Set(isRecord(schema.properties) ? Object.keys(schema.properties) : []);
    for (const key of ['allOf', 'anyOf', 'oneOf']) {
        const parts = schema[key];
        if (!Array.isArray(parts)) continue;
        for (const part of parts) {
            for (const name of extractTopLevelPropertyNames(part)) names.add(name);
        }
    }
    return names;
}

function resolveAccess(
    method: ApiMethod,
    path: string,
    operationId: string,
): Pick<ApiOperation, 'access' | 'unavailableReason'> {
    if (method === 'DELETE') return { access: API_ACCESS.UNAVAILABLE, unavailableReason: DELETE_REASON };
    if (SYNC_RUN_PATH_REGEX.test(path)) return { access: API_ACCESS.UNAVAILABLE, unavailableReason: SYNC_RUN_REASON };
    const reason = UNAVAILABLE_OPERATION_REASONS.get(operationId);
    if (reason) return { access: API_ACCESS.UNAVAILABLE, unavailableReason: reason };
    return { access: method === 'GET' ? API_ACCESS.READ : API_ACCESS.WRITE };
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
 * Builds the operation index from an OpenAPI document. Deprecated operations, HEAD operations and
 * anything outside `/v2/` are left out; malformed entries are skipped rather than failing the whole spec.
 */
export function buildApiOperationIndex(spec: unknown): Map<string, ApiOperation> {
    const index = new Map<string, ApiOperation>();
    const paths = isRecord(spec) && isRecord(spec.paths) ? spec.paths : {};
    for (const [path, pathItem] of Object.entries(paths)) {
        if (!path.startsWith('/v2/') || !isRecord(pathItem)) continue;
        for (const method of INDEXED_METHODS) {
            const parsed = openApiOperationValidator.safeParse(pathItem[method.toLowerCase()]);
            if (!parsed.success || parsed.data.deprecated) continue;
            const { operationId, summary, description, tags, parameters, requestBody } = parsed.data;
            const body = parseRequestBody(requestBody, spec);
            const declaredBodyFields = extractTopLevelPropertyNames(body?.schema);
            index.set(operationId, {
                operationId,
                method,
                path,
                summary: summary ?? '',
                description: description ?? '',
                tags: tags ?? [],
                parameters: parseParameters(parameters, spec),
                ...(body && { requestBody: body }),
                refusedBodyFields: [...REFUSED_BODY_FIELDS].filter((field) => declaredBodyFields.has(field)),
                ...resolveAccess(method, path, operationId),
            });
        }
    }
    return index;
}

let pendingIndex: Promise<Map<string, ApiOperation>> | undefined;

/**
 * The operation index, from the published spec, cached for an hour. Concurrent calls share one
 * download. A failed download throws: the tools never call an operation the spec does not list.
 */
export async function fetchApiOperationIndex(): Promise<Map<string, ApiOperation>> {
    const cached = apifyApiOperationsCache.get(APIFY_API_OPENAPI_URL);
    if (cached) return cached;
    pendingIndex ??= (async () => {
        const response = await fetch(APIFY_API_OPENAPI_URL);
        if (!response.ok) {
            throw new Error(
                `Failed to load the Apify API operations from ${APIFY_API_OPENAPI_URL}: HTTP ${response.status}.`,
            );
        }
        const index = buildApiOperationIndex(await response.json());
        apifyApiOperationsCache.set(APIFY_API_OPENAPI_URL, index);
        return index;
    })().finally(() => {
        pendingIndex = undefined;
    });
    return pendingIndex;
}

const SEARCH_STOP_WORDS: ReadonlySet<string> = new Set([
    'a',
    'all',
    'an',
    'and',
    'for',
    'in',
    'my',
    'of',
    'on',
    'or',
    'the',
    'to',
    'with',
]);

/** Lowercase words of a text, splitting camelCase, snake_case, kebab-case and paths. */
function splitWords(text: string): string[] {
    return text
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
}

/** A prefix match either way, so `runs` finds `run` and `env` finds `environment`. */
function hasMatchingWord(term: string, words: string[]): boolean {
    return words.some((word) => word.startsWith(term) || (word.length >= 3 && term.startsWith(word)));
}

/**
 * Operations matching the query's keywords, best first. A keyword scores 3 in the summary, else 2 in the
 * operation ID or path, else 1 in the tags. Ties go to the shorter path, so `/v2/datasets/{datasetId}`
 * comes before the same operation on a run's default dataset.
 */
export function searchApiOperations(index: Map<string, ApiOperation>, query: string, limit: number): ApiOperation[] {
    const terms = [...new Set(splitWords(query))].filter((term) => !SEARCH_STOP_WORDS.has(term));
    const scored: { operation: ApiOperation; score: number }[] = [];
    for (const operation of index.values()) {
        const summaryWords = splitWords(operation.summary);
        const idWords = splitWords(`${operation.operationId} ${operation.path}`);
        const tagWords = splitWords(operation.tags.join(' '));
        let score = 0;
        for (const term of terms) {
            if (hasMatchingWord(term, summaryWords)) score += 3;
            else if (hasMatchingWord(term, idWords)) score += 2;
            else if (hasMatchingWord(term, tagWords)) score += 1;
        }
        if (score > 0) scored.push({ operation, score });
    }
    return scored
        .sort((a, b) => b.score - a.score || a.operation.path.length - b.operation.path.length)
        .slice(0, limit)
        .map(({ operation }) => operation);
}
