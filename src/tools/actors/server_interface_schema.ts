import { HELPER_TOOLS, MAX_INLINE_BYTES } from '../../const.js';
import type { Actor } from '../../types.js';
import { ACTOR_TENANCY } from '../../types.js';
import { wrapJsonText } from '../../utils/encode_text.js';
import { resolveActorTenancy } from '../actor_tool_naming.js';
import type { DereferenceContext } from '../api/apify_api_spec.js';
import {
    API_METHODS,
    DereferenceBudgetError,
    isRecord,
    parseParameters,
    parseRequestBody,
    resolveLocalRef,
} from '../api/apify_api_spec.js';

type ServerOperation = { method: string; path: string; operation: Record<string, unknown> };

/** Alias hops followed per parameter; real chains take one or two. */
const MAX_ALIAS_HOPS = 16;

const MAX_NAMED_OPERATIONS = 5;
const MAX_NAMED_OPERATIONS_LENGTH = 300;

/** Follows local parameter or request-body aliases, without expanding nested schemas. */
function resolveRef(node: unknown, spec: unknown): unknown {
    const seen = new Set<string>();
    let resolved = node;
    while (isRecord(resolved) && typeof resolved.$ref === 'string' && resolved.$ref.startsWith('#/')) {
        const ref = resolved.$ref;
        if (seen.has(ref) || seen.size >= MAX_ALIAS_HOPS) return undefined;
        seen.add(ref);
        resolved = resolveLocalRef(spec, ref);
    }
    return resolved;
}

/** Path-level parameters, each replaced by the operation parameter with the same resolved name and location. */
function mergeOperationParameters(pathParameters: unknown, operationParameters: unknown, schema: unknown): unknown[] {
    const merged = new Map<unknown, unknown>();
    const parameters = [pathParameters, operationParameters].flatMap((list) => (Array.isArray(list) ? list : []));
    for (const parameter of parameters) {
        const resolved = resolveRef(parameter, schema);
        const isNamed = isRecord(resolved) && typeof resolved.name === 'string';
        merged.set(isNamed ? JSON.stringify([resolved.in, resolved.name]) : parameter, parameter);
    }
    return [...merged.values()];
}

/** One entry per method on each path, e.g. `paths: { '/search': { get, post } }` → `GET /search`, `POST /search`. */
function listServerOperations(schema: unknown): ServerOperation[] {
    if (!isRecord(schema) || !isRecord(schema.paths)) return [];
    const operations: ServerOperation[] = [];
    for (const [path, pathItem] of Object.entries(schema.paths)) {
        if (!isRecord(pathItem)) continue;
        for (const method of API_METHODS) {
            const operation = pathItem[method.toLowerCase()];
            if (!isRecord(operation)) continue;
            const parameters = mergeOperationParameters(pathItem.parameters, operation.parameters, schema);
            operations.push({
                method,
                path,
                operation: parameters.length > 0 ? { ...operation, parameters } : operation,
            });
        }
    }
    return operations;
}

/** Required parameter names, then the request body if required, e.g. `['q', 'request body']`. */
function listRequiredInputs(operation: Record<string, unknown>, schema: unknown): string[] {
    const names: string[] = [];
    for (const parameter of Array.isArray(operation.parameters) ? operation.parameters : []) {
        const resolved = resolveRef(parameter, schema);
        if (isRecord(resolved) && resolved.required === true && typeof resolved.name === 'string') {
            names.push(resolved.name);
        }
    }
    const requestBody = resolveRef(operation.requestBody, schema);
    if (isRecord(requestBody) && requestBody.required === true) names.push('request body');
    return names;
}

/**
 * Each operation with its required inputs, e.g.
 * `['GET / (required: query)', 'POST / (required: request body)', 'GET /status']`.
 */
export function listDocumentedOperations(schema: unknown): string[] {
    if (!isRecord(schema)) return [];
    return listServerOperations(schema).map(({ method, path, operation }) => {
        const required = listRequiredInputs(operation, schema);
        return required.length > 0 ? `${method} ${path} (required: ${required.join(', ')})` : `${method} ${path}`;
    });
}

/** E.g. `- GET /search: Search the web. Required: q, request body.` */
function formatOperationLine({ method, path, operation }: ServerOperation, schema: unknown): string {
    const required = listRequiredInputs(operation, schema);
    let text = `- ${method} ${path}`;
    if (typeof operation.summary === 'string') {
        text += `: ${operation.summary}`;
        if (required.length > 0 && !/[.!?]$/.test(operation.summary)) text += '.';
    }
    if (required.length > 0) text += ` Required: ${required.join(', ')}.`;
    return text;
}

/** One line per operation; over `maxBytes`, the lines that fit, then `… and N more`. */
function formatOperationIndex(operations: ServerOperation[], schema: unknown, maxBytes: number): string {
    const lines = operations.map((operation) => formatOperationLine(operation, schema));
    const index = lines.join('\n');
    if (Buffer.byteLength(index) <= maxBytes) return index;
    // Room for the cut line with the largest count it can show.
    let bytes = Buffer.byteLength(`… and ${lines.length} more`);
    const kept: string[] = [];
    for (const line of lines) {
        bytes += Buffer.byteLength(line) + 1;
        if (bytes > maxBytes) break;
        kept.push(line);
    }
    return [...kept, `… and ${lines.length - kept.length} more`].join('\n');
}

/**
 * One operation in the `get-apify-api-details` shape: local references inlined, examples kept, no responses.
 * The summary and description are left out when the schema has none. Throws `DereferenceBudgetError` when the
 * context's budget runs out.
 */
function buildServerOperationDetails({ method, path, operation }: ServerOperation, context: DereferenceContext) {
    const requestBody = parseRequestBody(operation.requestBody, context);
    return {
        method,
        path,
        ...(typeof operation.summary === 'string' && { summary: operation.summary }),
        ...(typeof operation.description === 'string' && { description: operation.description }),
        parameters: parseParameters(Array.isArray(operation.parameters) ? operation.parameters : undefined, context),
        ...(requestBody && { requestBody }),
    };
}

/** `render` as fenced JSON; `undefined` when its references expand past `MAX_INLINE_BYTES`. */
function formatWithinBudget(schema: unknown, render: (context: DereferenceContext) => unknown): string | undefined {
    const budget = { remainingBytes: MAX_INLINE_BYTES };
    try {
        return wrapJsonText(render({ spec: schema, shouldKeepExamples: true, budget }));
    } catch (error) {
        // A deep untrusted schema or example can exhaust the stack in JSON.stringify.
        if (error instanceof DereferenceBudgetError || error instanceof RangeError) return undefined;
        throw error;
    }
}

/** E.g. `3 documented operations: GET /add, POST /add, GET /empty`; over the naming limits, the count alone. */
function formatOperationCount(operations: ServerOperation[]): string {
    const count = `${operations.length} documented operation${operations.length === 1 ? '' : 's'}`;
    const names = operations.map(({ method, path }) => `${method} ${path}`).join(', ');
    const isNamed = operations.length <= MAX_NAMED_OPERATIONS && names.length <= MAX_NAMED_OPERATIONS_LENGTH;
    return isNamed ? `${count}: ${names}` : count;
}

/** E.g. `fetch-actor-details with {"actor":"apify/search","output":{"serverInterface":true}}` */
function formatDetailsCall(actorFullName: string, serverInterface: true | string): string {
    return `${HELPER_TOOLS.ACTOR_GET_DETAILS} with ${JSON.stringify({ actor: actorFullName, output: { serverInterface } })}`;
}

/** `undefined` text: the rendering ran out of its budget, so it would not fit. */
function checkSize(text: string | undefined, actorFullName: string): { text: string } | { error: string } {
    if (text !== undefined && Buffer.byteLength(text) <= MAX_INLINE_BYTES) return { text };
    return {
        error: `Actor '${actorFullName}' server-interface output exceeds the ${MAX_INLINE_BYTES}-byte limit and was not returned. A smaller operation may fit.`,
    };
}

/**
 * The server-interface text of `fetch-actor-details`, by `output.serverInterface`; none for an Actor without
 * Actor Standby unless asked for. Operations are rendered by `buildServerOperationDetails`, without the schema's
 * responses, components and `servers`.
 * - `false`: one summary line with the tenancy and the operation count, naming the operations while few and short;
 *   none in a session without `send-server-actor-request`.
 * - `true`: every operation in full when the text fits `MAX_INLINE_BYTES`; otherwise one line per operation
 *   (`formatOperationLine`), cut at the limit with `… and N more`.
 * - `"GET /search"`: that one operation in full.
 * The send-tool example becomes the Actor's base URL without the send tool or in agentic payment mode.
 * An unknown selection, or one operation over the byte cap, is an error.
 */
export function buildServerInterfaceText({
    actor,
    actorFullName,
    schema,
    serverInterface,
    loadedToolNames,
    hasPaymentProvider,
}: {
    actor: Pick<Actor, 'actorStandby' | 'standbyUrl'>;
    actorFullName: string;
    schema: unknown;
    serverInterface: boolean | string;
    loadedToolNames: readonly string[];
    /** An agentic payment provider (x402, Skyfire) cannot pay for an Actor Server request. */
    hasPaymentProvider: boolean;
}): { text?: string } | { error: string } {
    // The summary helps choose between call-actor and the send tool, so it follows the send tool.
    if (serverInterface === false && !loadedToolNames.includes(HELPER_TOOLS.ACTOR_SERVER_REQUEST)) return {};
    if (actor.actorStandby?.isEnabled !== true) {
        return { text: serverInterface === false ? undefined : `Actor '${actorFullName}' has no server interface.` };
    }
    const tenancy = resolveActorTenancy(actor);
    const operations = listServerOperations(schema);
    if (!isRecord(schema) || operations.length === 0) {
        return { text: `Server interface: enabled, ${tenancy}, undocumented: no API schema. See the README.` };
    }
    const listsThem = `${formatDetailsCall(actorFullName, true)} lists them.`;
    if (serverInterface === false) {
        return { text: `Server interface: enabled, ${tenancy}, ${formatOperationCount(operations)}. ${listsThem}` };
    }

    const canSend = !hasPaymentProvider && loadedToolNames.includes(HELPER_TOOLS.ACTOR_SERVER_REQUEST);
    const idleTimeoutSecs = actor.actorStandby?.idleTimeoutSecs;
    const idleTimeout = idleTimeoutSecs === undefined ? 'its idle timeout' : `its idle timeout of ${idleTimeoutSecs} s`;
    // What a request costs, by tenancy; a payment provider cannot pay for one.
    const notice = hasPaymentProvider
        ? 'Requests to a server interface are not supported in agentic payment mode.'
        : tenancy === ACTOR_TENANCY.MULTI_TENANT
          ? `${tenancy}: requests are charged per event and start no run in your account.`
          : `${tenancy}: the first request starts a run in your account, kept for ${idleTimeout}.`;
    // The send tool adds the host itself; without it, the base URL is how the user reaches the API.
    const header = `${notice}\n${canSend ? '' : `Base URL: ${actor.standbyUrl ?? 'not configured'}\n`}`;
    const send = (lead: string, { method, path }: ServerOperation) =>
        canSend
            ? `${HELPER_TOOLS.ACTOR_SERVER_REQUEST} sends ${lead}: ${JSON.stringify({ actor: actorFullName, method, path })}\n`
            : '';
    if (serverInterface === true) {
        const title = `# Server interface of ${actorFullName}\n${header}${send('a request to one of them', operations[0])}Operations (${operations.length}):\n`;
        const details = formatWithinBudget(schema, (context) => ({
            operations: operations.map((operation) => buildServerOperationDetails(operation, context)),
        }));
        const full = details && `${title}${details}`;
        if (full && Buffer.byteLength(full) <= MAX_INLINE_BYTES) return { text: full };
        const { method, path } = operations[0];
        const next = `The operations in full exceed the ${MAX_INLINE_BYTES}-byte limit. ${formatDetailsCall(actorFullName, `${method} ${path}`)} returns one operation in full.`;
        const index = formatOperationIndex(
            operations,
            schema,
            MAX_INLINE_BYTES - Buffer.byteLength(`${title}\n${next}`),
        );
        return checkSize(`${title}${index}\n${next}`, actorFullName);
    }

    const match = /^\s*([A-Za-z]+)\s+(\S+)\s*$/.exec(serverInterface);
    const selected = operations.find(({ method, path }) => method === match?.[1].toUpperCase() && path === match[2]);
    if (!selected) {
        return {
            error: `Actor '${actorFullName}' has no operation "${serverInterface}". ${formatOperationCount(operations)}. ${listsThem}`,
        };
    }
    const details = formatWithinBudget(schema, (context) => buildServerOperationDetails(selected, context));
    const title = `# Server interface of ${actorFullName}: ${selected.method} ${selected.path}\n`;
    return checkSize(details && `${title}${header}${send('this request', selected)}${details}`, actorFullName);
}
