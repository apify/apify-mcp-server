import { HELPER_TOOLS } from '../../const.js';
import type { Actor } from '../../types.js';
import { ACTOR_TENANCY } from '../../types.js';
import { wrapJsonText } from '../../utils/encode_text.js';
import { resolveActorTenancy } from '../actor_tool_naming.js';
import { isRecord, resolveLocalRef, resolveLocalRefs } from '../api/apify_api_spec.js';
import { listServerOperations, type ServerOperation } from './actor_definition.js';

/** What a local `$ref` on `node` points to, one level deep; `node` itself when it has none. */
function resolveRef(node: unknown, root: Record<string, unknown>): unknown {
    if (!isRecord(node) || typeof node.$ref !== 'string' || !node.$ref.startsWith('#/')) return node;
    return resolveLocalRef(root, node.$ref);
}

/** The names of the required parameters, and `request body` when it is required. */
function listRequiredInputs(operation: Record<string, unknown>, schema: Record<string, unknown>): string[] {
    const parameters = Array.isArray(operation.parameters)
        ? operation.parameters.map((parameter) => resolveRef(parameter, schema))
        : [];
    const names = parameters
        .filter((parameter) => isRecord(parameter) && parameter.required === true && typeof parameter.name === 'string')
        .map((parameter) => (parameter as { name: string }).name);
    const requestBody = resolveRef(operation.requestBody, schema);
    return isRecord(requestBody) && requestBody.required === true ? [...names, 'request body'] : names;
}

function formatOperationLine({ method, path, operation }: ServerOperation, schema: Record<string, unknown>): string {
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

type ServerInterfaceSectionParams = {
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
    const { actor, actorFullName, schema = {}, selection, loadedToolNames } = params;
    const isEnabled = actor.actorStandby?.isEnabled === true;
    if (!isEnabled) {
        return selection === false ? undefined : { text: `Actor '${actorFullName}' has no server interface.` };
    }
    const tenancy = resolveActorTenancy(actor);
    const operations = listServerOperations(schema);
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
        const lines = operations.map((operation) => formatOperationLine(operation, schema)).join('\n');
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
    const detail = resolveLocalRefs({ description, parameters, requestBody, responses }, schema);
    const title = typeof summary === 'string' ? `\n${summary}` : '';
    return {
        text: `# Server interface: ${operation.method} ${operation.path}${title}\n${header}${wrapJsonText(detail)}`,
    };
}
