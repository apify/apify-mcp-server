import { HELPER_TOOLS, MAX_INLINE_BYTES } from '../../const.js';
import type { Actor } from '../../types.js';
import { ACTOR_TENANCY } from '../../types.js';
import { wrapJsonText } from '../../utils/encode_text.js';
import { resolveActorTenancy } from '../actor_tool_naming.js';
import { API_METHODS, isRecord, resolveLocalRef } from '../api/apify_api_spec.js';

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

function checkSize(text: string, actorFullName: string): { text: string } | { error: string } {
    if (Buffer.byteLength(text) <= MAX_INLINE_BYTES) return { text };
    return {
        error: `Actor '${actorFullName}' server-interface output exceeds the ${MAX_INLINE_BYTES}-byte limit and was not returned. A smaller operation or schema node may fit.`,
    };
}

/**
 * The server-interface text of `fetch-actor-details`, by `output.serverInterface`; none for an Actor without
 * Actor Standby unless asked for. References are not expanded or fetched, and the schema's `servers` are not used.
 * - `false`: one summary line with the tenancy and the operation count, naming the operations while few and short;
 *   none in a session without `send-server-actor-request`.
 * - `true`: the operation list, plus the creator-written schema as is when the text fits `MAX_INLINE_BYTES`.
 * - `"GET /search"`: one operation excerpt with inherited parameters and the root schema/security context.
 * - `"#/components/schemas/Search"`: the raw node at that local JSON pointer.
 * The send-tool example becomes the Actor's base URL without the send tool or in agentic payment mode.
 * An unknown selection, or a selected text over the byte cap, is an error.
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
    const guidance = `References are not expanded or fetched. ${formatDetailsCall(actorFullName, '#/components/schemas/Name')} returns the raw node at a local JSON pointer. The schema's servers are not used.\n`;
    if (serverInterface === true) {
        const lines = operations.map((operation) => formatOperationLine(operation, schema)).join('\n');
        const { method, path } = operations[0];
        const excerpt = `${formatDetailsCall(actorFullName, `${method} ${path}`)} returns one operation excerpt.\n`;
        const list = `# Server interface of ${actorFullName}\n${header}Operations (${operations.length}):\n${lines}\n${send('a request to one of them', operations[0])}${excerpt}${guidance}`;
        const full = `${list}Full API schema:\n${wrapJsonText(schema)}`;
        if (Buffer.byteLength(full) <= MAX_INLINE_BYTES) return { text: full };
        const omitted = `Full API schema omitted: exceeds the ${MAX_INLINE_BYTES}-byte limit. Operation excerpts and referenced nodes are available through the navigation above.`;
        return checkSize(`${list}${omitted}`, actorFullName);
    }
    if (serverInterface.startsWith('#/')) {
        const node = resolveLocalRef(schema, serverInterface);
        if (node === undefined)
            return { error: `Actor '${actorFullName}' has no schema node at "${serverInterface}".` };
        const title = `# Server interface of ${actorFullName}: ${serverInterface}\n`;
        return checkSize(`${title}${header}${guidance}${wrapJsonText(node)}`, actorFullName);
    }

    const match = /^\s*([A-Za-z]+)\s+(\S+)\s*$/.exec(serverInterface);
    const selected = operations.find(({ method, path }) => method === match?.[1].toUpperCase() && path === match[2]);
    if (!selected) {
        return {
            error: `Actor '${actorFullName}' has no operation "${serverInterface}". ${formatOperationCount(operations)}. ${listsThem}`,
        };
    }
    const { method, path, operation } = selected;
    const summary = typeof operation.summary === 'string' ? `\n${operation.summary}` : '';
    const { openapi, jsonSchemaDialect, security } = schema;
    const detail = wrapJsonText({ openapi, jsonSchemaDialect, security, operation });
    const title = `# Server interface of ${actorFullName}: ${method} ${path}${summary}\n`;
    const note = `Operation excerpt. Components are omitted.\n${guidance}`;
    return checkSize(`${title}${header}${send('this request', selected)}${note}${detail}`, actorFullName);
}
