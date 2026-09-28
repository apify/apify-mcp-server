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
export const API_METHODS = ['GET', 'POST', 'PUT', 'DELETE'] as const;
type ApiMethod = (typeof API_METHODS)[number];

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
    'Start the run with POST /v2/actors/{actorId}/runs or POST /v2/actor-tasks/{actorTaskId}/runs instead.';
const METAMORPH_REASON =
    'It turns the run into a run of another Actor, which cannot be undone. Only the Actor itself metamorphs its run.';

/** Synchronous run paths. Some are GET, but every one of them starts a paid run. */
const SYNC_RUN_PATH_REGEX = /\/run-sync(-get-dataset-items)?$/;

const PATH_PLACEHOLDER_REGEX = /\{[^{}]+\}/g;

/**
 * The key of an operation in the rules below: its method and path template, with every placeholder
 * written `{}`, such as `POST /v2/actor-runs/{}/charge`. The rules are keyed by path, the API's
 * contract, not by operation ID, which is docs metadata and can be renamed; `{}` keeps a renamed
 * path parameter from lifting a rule.
 */
function toRuleKey(methodAndPath: string): string {
    return methodAndPath.replace(PATH_PLACEHOLDER_REGEX, '{}');
}

function keyRules<Value>(rules: readonly (readonly [string, Value])[]): ReadonlyMap<string, Value> {
    return new Map(rules.map(([methodAndPath, value]) => [toRuleKey(methodAndPath), value]));
}

const BROWSER_INFO_REASON =
    'It returns the request headers, and with them the API token the server adds to every request.';

/** Operations the API tools refuse by method and path, with the reason they report. */
const UNAVAILABLE_OPERATION_REASONS = keyRules([
    ['PUT /v2/users/me/limits', "It changes the account's spending limits. The user can change them in Apify Console."],
    [
        'POST /v2/actor-runs/{runId}/charge',
        'It charges the user of a pay-per-event run. Only the Actor itself charges for its events.',
    ],
    ['POST /v2/actor-runs/{runId}/metamorph', METAMORPH_REASON],
    ['POST /v2/actors/{actorId}/runs/last/metamorph', METAMORPH_REASON],
    ['POST /v2/actor-tasks/{actorTaskId}/runs/last/metamorph', METAMORPH_REASON],
    // A proxy test endpoint; its DELETE is refused like every DELETE.
    ['GET /v2/browser-info', BROWSER_INFO_REASON],
    ['POST /v2/browser-info', BROWSER_INFO_REASON],
    ['PUT /v2/browser-info', BROWSER_INFO_REASON],
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

/** Refused fields the API accepts on an operation although its body schema does not declare them. */
const UNDECLARED_REFUSED_BODY_FIELDS = keyRules([['POST /v2/actors', ['pricingInfos', 'actorPermissionLevel']]]);

/** Every rule key, each of which must match an operation of the spec. */
const RULE_KEYS: readonly string[] = [
    ...UNAVAILABLE_OPERATION_REASONS.keys(),
    ...UNDECLARED_REFUSED_BODY_FIELDS.keys(),
];

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

/** Lowercase words of a text, splitting camelCase, snake_case, kebab-case, and paths. */
function splitWords(text: string): string[] {
    return text
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
}

function resolveAccess(
    method: ApiMethod,
    path: string,
    ruleKey: string,
): Pick<ApiOperation, 'access' | 'unavailableReason'> {
    if (method === 'DELETE') return { access: API_ACCESS.UNAVAILABLE, unavailableReason: DELETE_REASON };
    if (SYNC_RUN_PATH_REGEX.test(path)) return { access: API_ACCESS.UNAVAILABLE, unavailableReason: SYNC_RUN_REASON };
    const reason = UNAVAILABLE_OPERATION_REASONS.get(ruleKey);
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
 * Builds the operation index from an OpenAPI document. Deprecated operations, HEAD operations,
 * and anything outside `/v2/` are left out; malformed entries are skipped rather than failing the whole spec.
 * It throws when the spec lists no operation, and when an operation a rule is about is missing from
 * it: a moved path would otherwise lift the refusal, so the tools stop until the rules are updated.
 */
export function buildApiOperationIndex(spec: unknown): Map<string, ApiOperation> {
    const index = new Map<string, ApiOperation>();
    // Every operation the spec lists, deprecated or malformed ones too, to check the rules against.
    const specRuleKeys = new Set<string>();
    const paths = isRecord(spec) && isRecord(spec.paths) ? spec.paths : {};
    for (const [path, pathItem] of Object.entries(paths)) {
        if (!path.startsWith('/v2/') || !isRecord(pathItem)) continue;
        for (const method of API_METHODS) {
            const ruleKey = toRuleKey(`${method} ${path}`);
            if (pathItem[method.toLowerCase()] !== undefined) specRuleKeys.add(ruleKey);
            const parsed = openApiOperationValidator.safeParse(pathItem[method.toLowerCase()]);
            if (!parsed.success || parsed.data.deprecated) continue;
            const { operationId, summary, description, tags, parameters, requestBody } = parsed.data;
            const body = parseRequestBody(requestBody, spec);
            const declaredBodyFields = extractTopLevelPropertyNames(body?.schema);
            const undeclaredRefusedFields = UNDECLARED_REFUSED_BODY_FIELDS.get(ruleKey) ?? [];
            index.set(operationId, {
                operationId,
                method,
                path,
                summary: summary ?? '',
                description: description ?? '',
                docsUrl: `${API_DOCS_BASE_URL}/${splitWords(operationId).join('-')}`,
                tags: tags ?? [],
                parameters: parseParameters(parameters, spec),
                ...(body && { requestBody: body }),
                refusedBodyFields: [...REFUSED_BODY_FIELDS].filter(
                    (field) => declaredBodyFields.has(field) || undeclaredRefusedFields.includes(field),
                ),
                ...resolveAccess(method, path, ruleKey),
            });
        }
    }
    if (index.size === 0) throw new Error('the spec lists no /v2/ operations.');
    const missingRuleKeys = RULE_KEYS.filter((ruleKey) => !specRuleKeys.has(ruleKey));
    if (missingRuleKeys.length > 0) {
        throw new Error(
            `the spec no longer lists ${missingRuleKeys.join(', ')}, which the API tools have rules for. ` +
                'Update the rules in apify_api_spec.ts.',
        );
    }
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
    // An index without operations, or without an operation a rule refuses, is not cached.
    try {
        return buildApiOperationIndex(spec);
    } catch (error) {
        throw new Error(`${failure}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * The operation index, from the published spec, cached for an hour. Concurrent calls share one
 * download. A failed download throws and is not cached: the tools never call an operation the spec
 * does not list, and the next call tries again.
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

/** Verbs for what each method does, so a verb the summary does not use, such as rename, still counts. */
const METHOD_VERBS: Record<ApiMethod, readonly string[]> = {
    GET: ['get', 'list', 'read'],
    POST: ['add', 'create', 'push', 'start'],
    PUT: ['update', 'set', 'rename', 'change'],
    DELETE: ['delete', 'remove'],
};

/** A prefix match, or the plural of a word, so `env` finds `environment` and `runs` finds `run`. */
function hasMatchingWord(term: string, words: string[]): boolean {
    return words.some((word) => word.startsWith(term) || term === `${word}s`);
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
 * Operations matching the query's keywords, best first. A keyword scores 3 in the summary, else 2 in the
 * operation ID or path, else 1 in the tags, else 2 when it is a verb for the operation's method. A verb
 * alone does not match an operation. A run-scoped path loses 2 when no keyword is about runs or tasks.
 * Ties go to an available operation, then to the shorter path, so `/v2/datasets/{datasetId}` comes
 * before the same operation on a run's default dataset.
 */
export function searchApiOperations(index: Map<string, ApiOperation>, query: string, limit: number): ApiOperation[] {
    // One-letter terms, such as the s of "run's", match too many words.
    const terms = [...new Set(splitWords(query))].filter((term) => term.length > 1 && !SEARCH_STOP_WORDS.has(term));
    const isAboutRuns = terms.some((term) => RUN_SCOPE_TERMS.has(term));
    const scored: { operation: ApiOperation; score: number }[] = [];
    for (const operation of index.values()) {
        const summaryWords = splitWords(operation.summary);
        const idWords = splitWords(`${operation.operationId} ${operation.path}`);
        const tagWords = splitWords(operation.tags.join(' '));
        const verbs = METHOD_VERBS[operation.method];
        let score = 0;
        let verbScore = 0;
        for (const term of terms) {
            if (hasMatchingWord(term, summaryWords)) score += 3;
            else if (hasMatchingWord(term, idWords)) score += 2;
            else if (hasMatchingWord(term, tagWords)) score += 1;
            else if (verbs.includes(term)) verbScore += 2;
        }
        if (score === 0) continue;
        const penalty = !isAboutRuns && RUN_SCOPED_PATH_REGEX.test(operation.path) ? RUN_SCOPED_PENALTY : 0;
        scored.push({ operation, score: score + verbScore - penalty });
    }
    const isUnavailable = (operation: ApiOperation) => (operation.access === API_ACCESS.UNAVAILABLE ? 1 : 0);
    return scored
        .sort(
            (a, b) =>
                b.score - a.score ||
                isUnavailable(a.operation) - isUnavailable(b.operation) ||
                a.operation.path.length - b.operation.path.length,
        )
        .slice(0, limit)
        .map(({ operation }) => operation);
}
