import { HELPER_TOOLS, MAX_INLINE_BYTES, SERVER_ACTOR_REQUEST_METHODS } from '../../const.js';
import type { Actor } from '../../types.js';
import { ACTOR_TENANCY } from '../../types.js';
import { wrapJsonText } from '../../utils/encode_text.js';
import { resolveActorTenancy } from '../actor_tool_naming.js';
import { isRecord } from '../api/apify_api_spec.js';

type ServerOperation = { method: string; path: string; operation: Record<string, unknown> };

type ServerInterfaceSectionParams = {
    actor: Pick<Actor, 'actorStandby' | 'standbyUrl'>;
    actorFullName: string;
    /** The server-interface build's API schema; absent when the Actor has none. */
    schema: Record<string, unknown> | undefined;
    /** `true` returns the full schema when it fits; a string selects an operation or local JSON pointer. */
    serverInterface: true | string;
    loadedToolNames: readonly string[];
    /** An agentic payment provider (x402, Skyfire) cannot pay for an Actor Server request. */
    hasPaymentProvider: boolean;
};

/** Reads a raw local JSON pointer; own-property checks keep missing targets from resolving through prototypes. */
function resolveLocalRef(spec: unknown, ref: string): unknown {
    let node = spec;
    for (const segment of ref.slice(2).split('/')) {
        const key = segment.replaceAll('~1', '/').replaceAll('~0', '~');
        if (typeof node !== 'object' || node === null || !Object.hasOwn(node, key)) return undefined;
        node = (node as Record<string, unknown>)[key];
    }
    return node;
}

/** Follows local parameter or request-body aliases for the operation list, without expanding nested schemas. */
function resolveRef(node: unknown, spec: unknown): unknown {
    const seen = new Set<string>();
    let resolved = node;
    while (isRecord(resolved) && typeof resolved.$ref === 'string' && resolved.$ref.startsWith('#/')) {
        const ref = resolved.$ref;
        if (seen.has(ref)) return undefined;
        seen.add(ref);
        resolved = resolveLocalRef(spec, ref);
    }
    return resolved;
}

/**
 * Operation parameters override path-level parameters by their resolved name and location, e.g.
 * path `[{ in: 'query', name: 'q' }]` + operation `[{ in: 'query', name: 'q', required: true }]` → the operation's `q`.
 */
function mergeOperationParameters(pathParameters: unknown, operationParameters: unknown, schema: unknown): unknown[] {
    const merged = new Map<unknown, unknown>();
    const parameters = [
        ...(Array.isArray(pathParameters) ? pathParameters : []),
        ...(Array.isArray(operationParameters) ? operationParameters : []),
    ];
    for (const parameter of parameters) {
        const resolved = resolveRef(parameter, schema);
        const key =
            isRecord(resolved) && typeof resolved.name === 'string'
                ? JSON.stringify([resolved.in, resolved.name])
                : parameter;
        merged.set(key, parameter);
    }
    return [...merged.values()];
}

/**
 * One entry per method on each path (an OpenAPI operation), e.g.
 * `paths: { '/search': { get, post }, '/status': { get } }` → `GET /search`, `POST /search`, `GET /status`.
 */
function listServerOperations(schema: unknown): ServerOperation[] {
    if (!isRecord(schema) || !isRecord(schema.paths)) return [];
    const operations: ServerOperation[] = [];
    for (const [path, pathItem] of Object.entries(schema.paths)) {
        if (!isRecord(pathItem)) continue;
        for (const method of SERVER_ACTOR_REQUEST_METHODS) {
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
function listRequiredInputs(operation: Record<string, unknown>, schema: Record<string, unknown>): string[] {
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

/** E.g. `- GET /search: Search the web. Required: q.` */
function formatOperationLine({ method, path, operation }: ServerOperation, schema: Record<string, unknown>): string {
    const required = listRequiredInputs(operation, schema);
    let text = `- ${method} ${path}`;
    if (typeof operation.summary === 'string') {
        text += `: ${operation.summary}`;
        if (required.length > 0 && !/[.!?]$/.test(operation.summary)) text += '.';
    }
    if (required.length > 0) text += ` Required: ${required.join(', ')}.`;
    return text;
}

/**
 * What a request costs, by tenancy, e.g.
 * `single-tenant: the first request starts a run in your account, kept for its idle timeout of 60 s`.
 */
function formatTenancy(actor: Pick<Actor, 'actorStandby'>): string {
    if (resolveActorTenancy(actor) === ACTOR_TENANCY.MULTI_TENANT) {
        return `${ACTOR_TENANCY.MULTI_TENANT}: requests are charged per event and start no run in your account`;
    }
    const idleTimeoutSecs = actor.actorStandby?.idleTimeoutSecs;
    const idleTimeout = idleTimeoutSecs === undefined ? 'its idle timeout' : `its idle timeout of ${idleTimeoutSecs} s`;
    return `${ACTOR_TENANCY.SINGLE_TENANT}: the first request starts a run in your account, kept for ${idleTimeout}`;
}

/** What the list and the detail share: the tenancy or payment notice, and the base URL when the send tool is absent. */
type SectionContext = { actorFullName: string; header: string; canSend: boolean };

/** E.g. `send-server-actor-request sends this request: {"actor":"apify/search","method":"GET","path":"/search"}` */
function formatSendExample(lead: string, actorFullName: string, { method, path }: ServerOperation): string {
    return `${HELPER_TOOLS.ACTOR_SERVER_REQUEST} sends ${lead}: ${JSON.stringify({ actor: actorFullName, method, path })}\n`;
}

/** E.g. `fetch-actor-details with {"actor":"apify/search","output":{"serverInterface":true}}` */
function formatDetailsCall(actorFullName: string, serverInterface: true | string): string {
    return `${HELPER_TOOLS.ACTOR_GET_DETAILS} with ${JSON.stringify({ actor: actorFullName, output: { serverInterface } })}`;
}

function formatSchemaGuidance(actorFullName: string): string {
    return `References are not expanded or fetched. ${formatDetailsCall(actorFullName, '#/components/schemas/Name')} returns the raw node at a local JSON pointer. The schema's servers are not used.\n`;
}

function buildSectionResult(text: string, actorFullName: string): { text: string } | { error: string } {
    if (Buffer.byteLength(text) > MAX_INLINE_BYTES) {
        return {
            error: `Actor '${actorFullName}' server-interface output exceeds the ${MAX_INLINE_BYTES}-byte limit and was not returned. A smaller operation or schema node may fit.`,
        };
    }
    return { text };
}

/** The `serverInterface: true` output; see {@link buildServerInterfaceSection}. */
function buildOperationList(
    operations: ServerOperation[],
    schema: Record<string, unknown>,
    { actorFullName, header, canSend }: SectionContext,
): string {
    const lines = operations.map((operation) => formatOperationLine(operation, schema)).join('\n');
    const send = canSend ? formatSendExample('a request to one of them', actorFullName, operations[0]) : '';
    const { method, path } = operations[0];
    const details = `${formatDetailsCall(actorFullName, `${method} ${path}`)} returns one operation excerpt.\n`;
    return `# Server interface of ${actorFullName}\n${header}Operations (${operations.length}):\n${lines}\n${send}${details}${formatSchemaGuidance(actorFullName)}`;
}

/** The `serverInterface: "METHOD /path"` output; see {@link buildServerInterfaceSection}. */
function buildOperationDetail(
    serverOperation: ServerOperation,
    schema: Record<string, unknown>,
    { actorFullName, header, canSend }: SectionContext,
): string {
    const { method, path, operation } = serverOperation;
    const title = typeof operation.summary === 'string' ? `\n${operation.summary}` : '';
    const send = canSend ? formatSendExample('this request', actorFullName, serverOperation) : '';
    const detail = {
        openapi: schema.openapi,
        jsonSchemaDialect: schema.jsonSchemaDialect,
        security: schema.security,
        operation,
    };
    const note = `Operation excerpt. Components are omitted.\n${formatSchemaGuidance(actorFullName)}`;
    return `# Server interface of ${actorFullName}: ${method} ${path}${title}\n${header}${send}${note}${wrapJsonText(detail)}`;
}

function formatUndocumented(tenancy: string): string {
    return `Server interface: enabled, ${tenancy}, undocumented: no API schema. See the README.`;
}

/** Up to this many operations, the summary names each one, so an agent can send a request without guessing a path. */
const SUMMARY_MAX_NAMED_OPERATIONS = 5;

/**
 * The one line the default output (no `output` given) carries for a Server Actor; `undefined` for any other Actor.
 * For a single-tenant Server Actor documenting `GET /search` and `GET /status`:
 * ```
 * Server interface: enabled, single-tenant, 2 documented operations: GET /search, GET /status. fetch-actor-details with {"actor":"apify/search","output":{"serverInterface":true}} lists them.
 * ```
 * Over {@link SUMMARY_MAX_NAMED_OPERATIONS} operations, only their count.
 * Without an API schema: `Server interface: enabled, single-tenant, undocumented: no API schema. See the README.`
 */
export function buildServerInterfaceSummary({
    actor,
    actorFullName,
    schema = {},
}: Pick<ServerInterfaceSectionParams, 'actor' | 'actorFullName' | 'schema'>): string | undefined {
    if (actor.actorStandby?.isEnabled !== true) return undefined;
    const tenancy = resolveActorTenancy(actor);
    const operations = listServerOperations(schema);
    if (operations.length === 0) return formatUndocumented(tenancy);
    const count = `${operations.length} documented operation${operations.length === 1 ? '' : 's'}`;
    const names =
        operations.length <= SUMMARY_MAX_NAMED_OPERATIONS
            ? `: ${operations.map(({ method, path }) => `${method} ${path}`).join(', ')}`
            : '';
    return `Server interface: enabled, ${tenancy}, ${count}${names}. ${formatDetailsCall(actorFullName, true)} lists them.`;
}

/**
 * Server-interface navigation with tenancy and session-gated request guidance:
 * - `true`: operation list plus the full creator-written schema unchanged when the section fits `MAX_INLINE_BYTES`.
 *   Otherwise the list remains, with an explicit schema-omission notice.
 * - `"GET /search"`: one operation excerpt, including inherited parameters and root schema/security context.
 *   Components are omitted; the excerpt's references can be followed with the pointer form below.
 * - `"#/components/schemas/Search"`: the raw node at that JSON pointer in the original schema.
 *
 * Example `true` output (schema abbreviated here):
 * ````
 * # Server interface of apify/web-search
 * single-tenant: the first request starts a run in your account, kept for its idle timeout of 300 s.
 * Operations (1):
 * - GET /search: Search the web. Required: q.
 * send-server-actor-request sends a request to one of them: {"actor":"apify/search","method":"GET","path":"/search"}
 * fetch-actor-details with {"actor":"apify/search","output":{"serverInterface":"GET /search"}} returns one operation excerpt.
 * References are not expanded or fetched. fetch-actor-details with {"actor":"apify/search","output":{"serverInterface":"#/components/schemas/Name"}} returns the raw node at a local JSON pointer. The schema's servers are not used.
 * Full API schema:
 * ```json
 * {"openapi":"3.0.3","info":{"title":"Search","version":"1"},"paths":{"/search":{"get":{"summary":"Search the web","parameters":[{"name":"q","in":"query","required":true,"schema":{"type":"string"}}],"responses":{"200":{"description":"Search results."}}}}}}
 * ```
 * ````
 *
 * Without the send tool, or in agentic payment mode (whose notice replaces the tenancy line), the send line is
 * absent and the Actor's assigned `standbyUrl` is shown as the base URL. Schema `servers` are never used for requests.
 * Unknown operations/pointers return selection errors. A selected node or operation list over the byte cap returns
 * a size error without partial JSON. No references are expanded or fetched, and no schema validation is performed.
 */
export function buildServerInterfaceSection({
    actor,
    actorFullName,
    schema = {},
    serverInterface,
    loadedToolNames,
    hasPaymentProvider,
}: ServerInterfaceSectionParams): { text: string } | { error: string } {
    if (actor.actorStandby?.isEnabled !== true) return { text: `Actor '${actorFullName}' has no server interface.` };
    const operations = listServerOperations(schema);
    if (operations.length === 0) return { text: formatUndocumented(resolveActorTenancy(actor)) };
    const canSend = !hasPaymentProvider && loadedToolNames.includes(HELPER_TOOLS.ACTOR_SERVER_REQUEST);
    const notice = hasPaymentProvider
        ? 'Requests to a server interface are not supported in agentic payment mode.'
        : `${formatTenancy(actor)}.`;
    // The send tool adds the host itself; without it, the base URL is how the user reaches the API.
    const baseUrl = canSend ? '' : `Base URL: ${actor.standbyUrl ?? 'not configured'}\n`;
    const context = { actorFullName, header: `${notice}\n${baseUrl}`, canSend };
    if (serverInterface === true) {
        const list = buildOperationList(operations, schema, context);
        const full = `${list}Full API schema:\n${wrapJsonText(schema)}`;
        const text =
            Buffer.byteLength(full) <= MAX_INLINE_BYTES
                ? full
                : `${list}Full API schema omitted: exceeds the ${MAX_INLINE_BYTES}-byte limit. Operation excerpts and referenced nodes are available through the navigation above.`;
        return buildSectionResult(text, actorFullName);
    }
    if (serverInterface.startsWith('#/')) {
        const node = resolveLocalRef(schema, serverInterface);
        if (node === undefined)
            return { error: `Actor '${actorFullName}' has no schema node at "${serverInterface}".` };
        const text = `# Server interface of ${actorFullName}: ${serverInterface}\n${context.header}${formatSchemaGuidance(actorFullName)}${wrapJsonText(node)}`;
        return buildSectionResult(text, actorFullName);
    }

    const match = /^\s*([A-Za-z]+)\s+(\S+)\s*$/.exec(serverInterface);
    const operation = operations.find(({ method, path }) => method === match?.[1].toUpperCase() && path === match[2]);
    if (!operation) {
        const documented = operations.map(({ method, path }) => `${method} ${path}`).join(', ');
        return {
            error: `Actor '${actorFullName}' has no operation "${serverInterface}". Documented operations: ${documented}.`,
        };
    }
    return buildSectionResult(buildOperationDetail(operation, schema, context), actorFullName);
}
