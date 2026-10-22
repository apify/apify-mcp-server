import { HELPER_TOOLS } from '../../const.js';
import type { Actor } from '../../types.js';
import { ACTOR_TENANCY } from '../../types.js';
import { wrapJsonText } from '../../utils/encode_text.js';
import { resolveActorTenancy } from '../actor_tool_naming.js';

/** The HTTP methods an OpenAPI path item may hold an operation under. */
export const OPENAPI_OPERATION_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

type Operation = { method: string; path: string; operation: Record<string, unknown> };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The operations an OpenAPI document declares, in document order, with the method upper-cased as the agent writes it. */
export function listServerOperations(schema: Record<string, unknown>): Operation[] {
    if (!isRecord(schema.paths)) return [];
    return Object.entries(schema.paths).flatMap(([path, pathItem]) =>
        isRecord(pathItem)
            ? OPENAPI_OPERATION_METHODS.filter((method) => isRecord(pathItem[method])).map((method) => ({
                  method: method.toUpperCase(),
                  path,
                  operation: pathItem[method] as Record<string, unknown>,
              }))
            : [],
    );
}

function lookupJsonPointer(root: Record<string, unknown>, pointer: string): unknown {
    let node: unknown = root;
    for (const segment of pointer.split('/')) {
        const key = segment.replaceAll('~1', '/').replaceAll('~0', '~');
        if (!isRecord(node) || !(key in node)) return undefined;
        node = node[key];
    }
    return node;
}

/**
 * A copy of `node` with every local `$ref` (`#/components/...`) replaced by what it points to in `root`.
 * A reference that is circular, not found, or external stays as it is, with an `unavailableDetail` note;
 * nothing is fetched.
 */
export function resolveLocalRefs(node: unknown, root: Record<string, unknown>, seen: readonly string[] = []): unknown {
    if (Array.isArray(node)) return node.map((item) => resolveLocalRefs(item, root, seen));
    if (!isRecord(node)) return node;
    const { $ref } = node;
    if (typeof $ref !== 'string') {
        return Object.fromEntries(
            Object.entries(node).map(([key, value]) => [key, resolveLocalRefs(value, root, seen)]),
        );
    }
    if (seen.includes($ref)) return { $ref, unavailableDetail: 'circular reference' };
    if (!$ref.startsWith('#/')) return { $ref, unavailableDetail: 'external reference, not fetched' };
    const target = lookupJsonPointer(root, $ref.slice(2));
    if (target === undefined) return { $ref, unavailableDetail: 'reference not found' };
    return resolveLocalRefs(target, root, [...seen, $ref]);
}

/** The names of the required parameters, and `request body` when it is required, with local references resolved. */
function listRequiredInputs(operation: Record<string, unknown>, schema: Record<string, unknown>): string[] {
    const parameters = resolveLocalRefs(operation.parameters, schema);
    const names = Array.isArray(parameters)
        ? parameters
              .filter(
                  (parameter) =>
                      isRecord(parameter) && parameter.required === true && typeof parameter.name === 'string',
              )
              .map((parameter) => (parameter as { name: string }).name)
        : [];
    const requestBody = resolveLocalRefs(operation.requestBody, schema);
    return isRecord(requestBody) && requestBody.required === true ? [...names, 'request body'] : names;
}

function formatOperationLine({ method, path, operation }: Operation, schema: Record<string, unknown>): string {
    const required = listRequiredInputs(operation, schema);
    const summary = typeof operation.summary === 'string' ? `: ${operation.summary}${required.length ? '.' : ''}` : '';
    return `- ${method} ${path}${summary}${required.length ? ` Required: ${required.join(', ')}.` : ''}`;
}

/** What a request costs, by tenancy. */
function formatTenancy(actor: Pick<Actor, 'actorStandby'>): string {
    if (resolveActorTenancy(actor) === ACTOR_TENANCY.MULTI_TENANT) {
        return `${ACTOR_TENANCY.MULTI_TENANT}: requests are charged per event and start no run in your account`;
    }
    const idleTimeoutSecs = actor.actorStandby?.idleTimeoutSecs;
    const idleTimeout = idleTimeoutSecs === undefined ? 'its idle timeout' : `its idle timeout of ${idleTimeoutSecs} s`;
    return `${ACTOR_TENANCY.SINGLE_TENANT}: the first request starts a run in your account, kept for ${idleTimeout}`;
}

const EXPAND_HINT = 'output.serverInterface: true lists them, "METHOD /path" details one.';

export type ServerInterfaceSectionParams = {
    actor: Pick<Actor, 'actorStandby' | 'standbyUrl'>;
    actorFullName: string;
    /** The server-interface build's API schema; absent when the Actor has none. */
    schema: Record<string, unknown> | undefined;
    /** `true` lists the operations, a `METHOD /path` string details one, `false` gives the one-line summary. */
    selection: boolean | string;
    loadedToolNames: readonly string[];
};

/**
 * The server-interface section of `fetch-actor-details`: the one-line summary for the default output, the
 * operation list with the base URL (the Actor's `standbyUrl`, never the document's `servers`) and tenancy, or
 * one operation with its local references resolved. `undefined` when there is nothing to say (the default
 * output for an Actor without a server interface); `error` for a selection that names no operation.
 */
export function buildServerInterfaceSection(
    params: ServerInterfaceSectionParams,
): { text: string } | { error: string } | undefined {
    const { actor, actorFullName, schema, selection, loadedToolNames } = params;
    const isEnabled = actor.actorStandby?.isEnabled === true;
    const operations = schema ? listServerOperations(schema) : [];
    if (!isEnabled) {
        return selection === false ? undefined : { text: `Actor '${actorFullName}' has no server interface.` };
    }
    const tenancy = resolveActorTenancy(actor);
    if (operations.length === 0) {
        return { text: `Server interface: enabled, ${tenancy}, undocumented: no API schema. See the README.` };
    }
    if (selection === false) {
        const count = `${operations.length} documented operation${operations.length === 1 ? '' : 's'}`;
        return { text: `Server interface: enabled, ${tenancy}, ${count}. ${EXPAND_HINT}` };
    }
    const sendTool = loadedToolNames.includes(HELPER_TOOLS.ACTOR_SERVER_REQUEST)
        ? `Requests go through ${HELPER_TOOLS.ACTOR_SERVER_REQUEST}.\n`
        : '';
    const header = `${formatTenancy(actor)}.\nBase URL: ${actor.standbyUrl ?? 'not configured'}\n${sendTool}`;
    if (selection === true) {
        const lines = operations.map((operation) => formatOperationLine(operation, schema!)).join('\n');
        return {
            text: `# Server interface\n${header}Operations (${operations.length}):\n${lines}\noutput.serverInterface: "METHOD /path" details one operation.`,
        };
    }
    const match = /^\s*([A-Za-z]+)\s+(\S+)\s*$/.exec(selection);
    const operation = operations.find(({ method, path }) => method === match?.[1].toUpperCase() && path === match[2]);
    if (!operation) {
        const documented = operations.map(({ method, path }) => `${method} ${path}`).join(', ');
        return {
            error: `Actor '${actorFullName}' has no operation "${selection}". Documented operations: ${documented}.`,
        };
    }
    const { summary, description, parameters, requestBody, responses } = operation.operation;
    const detail = resolveLocalRefs({ description, parameters, requestBody, responses }, schema!);
    const title = typeof summary === 'string' ? `\n${summary}` : '';
    return {
        text: `# Server interface: ${operation.method} ${operation.path}${title}\n${header}${wrapJsonText(detail)}`,
    };
}
