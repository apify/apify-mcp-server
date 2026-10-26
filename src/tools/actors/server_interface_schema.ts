import { HELPER_TOOLS, SERVER_ACTOR_REQUEST_METHODS } from '../../const.js';
import type { Actor } from '../../types.js';
import { ACTOR_TENANCY } from '../../types.js';
import { wrapJsonText } from '../../utils/encode_text.js';
import { resolveActorTenancy } from '../actor_tool_naming.js';
import { isRecord, resolveLocalRefs, resolveRef } from '../api/apify_api_spec.js';

type ServerOperation = { method: string; path: string; operation: Record<string, unknown> };

type ServerInterfaceSectionParams = {
    actor: Pick<Actor, 'actorStandby' | 'standbyUrl'>;
    actorFullName: string;
    /** The server-interface build's API schema; absent when the Actor has none. */
    schema: Record<string, unknown> | undefined;
    /** `true` lists operations, a `METHOD /path` string details one. */
    serverInterface: true | string;
    loadedToolNames: readonly string[];
    /** An agentic payment provider (x402, Skyfire) cannot pay for an Actor Server request. */
    hasPaymentProvider: boolean;
};

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

/** The `serverInterface: true` output; see {@link buildServerInterfaceSection}. */
function buildOperationList(
    operations: ServerOperation[],
    schema: Record<string, unknown>,
    { actorFullName, header, canSend }: SectionContext,
): string {
    const lines = operations.map((operation) => formatOperationLine(operation, schema)).join('\n');
    const send = canSend ? formatSendExample('a request to one of them', actorFullName, operations[0]) : '';
    const { method, path } = operations[0];
    const details = `${formatDetailsCall(actorFullName, `${method} ${path}`)} returns one operation's parameters, request body and responses.`;
    return `# Server interface of ${actorFullName}\n${header}Operations (${operations.length}):\n${lines}\n${send}${details}`;
}

/** The `serverInterface: "METHOD /path"` output; see {@link buildServerInterfaceSection}. */
function buildOperationDetail(
    serverOperation: ServerOperation,
    schema: Record<string, unknown>,
    { actorFullName, header, canSend }: SectionContext,
): string {
    const { method, path, operation } = serverOperation;
    const { summary, description, parameters, requestBody, responses } = operation;
    const detail = resolveLocalRefs({ description, parameters, requestBody, responses }, schema);
    const title = typeof summary === 'string' ? `\n${summary}` : '';
    const send = canSend ? formatSendExample('this request', actorFullName, serverOperation) : '';
    return `# Server interface of ${actorFullName}: ${method} ${path}${title}\n${header}${send}${wrapJsonText(detail)}`;
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
 * The section `output.serverInterface` asks for: an operation list, or one operation with its local references
 * resolved. The base URL is the Actor's assigned `standbyUrl`, never the document's `servers` value.
 *
 * Output for a single-tenant Server Actor documenting `GET /search` and `GET /status`:
 *
 * `serverInterface: true`:
 * ```
 * # Server interface of apify/search
 * single-tenant: the first request starts a run in your account, kept for its idle timeout of 300 s.
 * Operations (2):
 * - GET /search: Search the web. Required: q.
 * - GET /status: Return the server status
 * send-server-actor-request sends a request to one of them: {"actor":"apify/search","method":"GET","path":"/search"}
 * fetch-actor-details with {"actor":"apify/search","output":{"serverInterface":"GET /search"}} returns one operation's parameters, request body and responses.
 * ```
 *
 * `serverInterface: 'GET /search'`:
 * ````
 * # Server interface of apify/search: GET /search
 * Search the web
 * single-tenant: the first request starts a run in your account, kept for its idle timeout of 300 s.
 * send-server-actor-request sends this request: {"actor":"apify/search","method":"GET","path":"/search"}
 * ```json
 * {"parameters":[{"name":"q","in":"query","required":true,"schema":{"type":"string"}}],"responses":{"200":{"description":"Search results."}}}
 * ```
 * ````
 *
 * Without the send tool, or with an agentic payment provider (whose notice replaces the tenancy line), the
 * send line is absent and `Base URL: https://search.apify.actor` follows the notice.
 *
 * Other cases:
 * - no API schema: `Server interface: enabled, single-tenant, undocumented: no API schema. See the README.`
 * - not a Server Actor: `Actor 'apify/search' has no server interface.`
 * - undocumented operation: `{ error: 'Actor \'apify/search\' has no operation "GET /nope". Documented operations: GET /search, GET /status.' }`
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
    if (serverInterface === true) return { text: buildOperationList(operations, schema, context) };

    const match = /^\s*([A-Za-z]+)\s+(\S+)\s*$/.exec(serverInterface);
    const operation = operations.find(({ method, path }) => method === match?.[1].toUpperCase() && path === match[2]);
    if (!operation) {
        const documented = operations.map(({ method, path }) => `${method} ${path}`).join(', ');
        return {
            error: `Actor '${actorFullName}' has no operation "${serverInterface}". Documented operations: ${documented}.`,
        };
    }
    return { text: buildOperationDetail(operation, schema, context) };
}
