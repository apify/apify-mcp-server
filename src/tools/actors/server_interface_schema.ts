import { HELPER_TOOLS, SERVER_ACTOR_REQUEST_METHODS } from '../../const.js';
import type { Actor } from '../../types.js';
import { ACTOR_TENANCY } from '../../types.js';
import { wrapJsonText } from '../../utils/encode_text.js';
import { resolveActorTenancy } from '../actor_tool_naming.js';
import { isRecord, resolveLocalRefs, resolveRef } from '../api/apify_api_spec.js';

const EXPAND_HINT = 'output.serverInterface: true lists them, "METHOD /path" details one.';

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

/** The `serverInterface: true` output; see {@link buildServerInterfaceSection}. */
function buildOperationList(operations: ServerOperation[], schema: Record<string, unknown>, header: string): string {
    const lines = operations.map((operation) => formatOperationLine(operation, schema)).join('\n');
    return `# Server interface\n${header}Operations (${operations.length}):\n${lines}\noutput.serverInterface: "METHOD /path" details one operation.`;
}

/** The `serverInterface: "METHOD /path"` output; see {@link buildServerInterfaceSection}. */
function buildOperationDetail(
    { method, path, operation }: ServerOperation,
    schema: Record<string, unknown>,
    header: string,
): string {
    const { summary, description, parameters, requestBody, responses } = operation;
    const detail = resolveLocalRefs({ description, parameters, requestBody, responses }, schema);
    const title = typeof summary === 'string' ? `\n${summary}` : '';
    return `# Server interface: ${method} ${path}${title}\n${header}${wrapJsonText(detail)}`;
}

function formatUndocumented(tenancy: string): string {
    return `Server interface: enabled, ${tenancy}, undocumented: no API schema. See the README.`;
}

/**
 * The one line the default output (no `output` given) carries for a Server Actor; `undefined` for any other Actor.
 * For a single-tenant Server Actor documenting `GET /search` and `GET /status`:
 * ```
 * Server interface: enabled, single-tenant, 2 documented operations. output.serverInterface: true lists them, "METHOD /path" details one.
 * ```
 * Without an API schema: `Server interface: enabled, single-tenant, undocumented: no API schema. See the README.`
 */
export function buildServerInterfaceSummary({
    actor,
    schema = {},
}: Pick<ServerInterfaceSectionParams, 'actor' | 'schema'>): string | undefined {
    if (actor.actorStandby?.isEnabled !== true) return undefined;
    const tenancy = resolveActorTenancy(actor);
    const operations = listServerOperations(schema);
    if (operations.length === 0) return formatUndocumented(tenancy);
    const count = `${operations.length} documented operation${operations.length === 1 ? '' : 's'}`;
    return `Server interface: enabled, ${tenancy}, ${count}. ${EXPAND_HINT}`;
}

/**
 * The section `output.serverInterface` asks for: an operation list, or one operation with its local references
 * resolved. The base URL is the Actor's assigned `standbyUrl`, never the document's `servers` value.
 *
 * Output for a single-tenant Server Actor documenting `GET /search` and `GET /status`:
 *
 * `serverInterface: true`:
 * ```
 * # Server interface
 * single-tenant: the first request starts a run in your account, kept for its idle timeout of 300 s.
 * Base URL: https://search.apify.actor
 * Requests go through send-server-actor-request.
 * Operations (2):
 * - GET /search: Search the web. Required: q.
 * - GET /status: Return the server status
 * output.serverInterface: "METHOD /path" details one operation.
 * ```
 *
 * `serverInterface: 'GET /search'`:
 * ````
 * # Server interface: GET /search
 * Search the web
 * single-tenant: the first request starts a run in your account, kept for its idle timeout of 300 s.
 * Base URL: https://search.apify.actor
 * Requests go through send-server-actor-request.
 * ```json
 * {"parameters":[{"name":"q","in":"query","required":true,"schema":{"type":"string"}}],"responses":{"200":{"description":"Search results."}}}
 * ```
 * ````
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
    const baseUrl = `Base URL: ${actor.standbyUrl ?? 'not configured'}\n`;
    const sendTool = loadedToolNames.includes(HELPER_TOOLS.ACTOR_SERVER_REQUEST)
        ? `Requests go through ${HELPER_TOOLS.ACTOR_SERVER_REQUEST}.\n`
        : '';
    const header = hasPaymentProvider
        ? `Requests to an Actor Server are not supported in agentic payment mode.\n${baseUrl}`
        : `${formatTenancy(actor)}.\n${baseUrl}${sendTool}`;
    if (serverInterface === true) return { text: buildOperationList(operations, schema, header) };

    const match = /^\s*([A-Za-z]+)\s+(\S+)\s*$/.exec(serverInterface);
    const operation = operations.find(({ method, path }) => method === match?.[1].toUpperCase() && path === match[2]);
    if (!operation) {
        const documented = operations.map(({ method, path }) => `${method} ${path}`).join(', ');
        return {
            error: `Actor '${actorFullName}' has no operation "${serverInterface}". Documented operations: ${documented}.`,
        };
    }
    return { text: buildOperationDetail(operation, schema, header) };
}
