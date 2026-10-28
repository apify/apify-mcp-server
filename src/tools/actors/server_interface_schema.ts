import { HELPER_TOOLS, MAX_INLINE_BYTES } from '../../const.js';
import type { Actor, ServerActorToolInfo } from '../../types.js';
import { ACTOR_TENANCY } from '../../types.js';
import { wrapJsonText } from '../../utils/encode_text.js';
import { resolveActorTenancy } from '../actor_tool_naming.js';
import type { DereferenceContext } from '../api/apify_api_spec.js';
import {
    API_METHODS,
    DereferenceBudgetError,
    isJsonMediaType,
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

/** Longest operations block in a selected Server Actor's tool description. */
export const SERVER_TOOL_OPERATIONS_MAX_BYTES = 8 * 1024;

/** Inputs an operation line names in each list; the rest are counted. */
const MAX_LISTED_INPUTS = 5;

/** A parameter or a top-level body property, as an operation line names it. */
type OperationInput = { name: string; type?: string; isRequired: boolean };

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

/** Follows one local reference: an operation line reads a type without expanding schemas. */
function resolveOneRef(node: unknown, schema: unknown): unknown {
    return isRecord(node) && typeof node.$ref === 'string' ? resolveLocalRef(schema, node.$ref) : node;
}

/** E.g. `string`, or `string|null` for a list of types; `undefined` when the schema names no type. */
function getTypeName(node: unknown, schema: unknown): string | undefined {
    const resolved = resolveOneRef(node, schema);
    if (!isRecord(resolved)) return undefined;
    const types = [resolved.type].flat().filter((type): type is string => typeof type === 'string');
    return types.length > 0 ? types.join('|') : undefined;
}

/** Path and query parameters, read as `parseParameters` reads them: a path parameter is required. */
function listParameterInputs(operation: Record<string, unknown>, schema: unknown): OperationInput[] {
    const inputs: OperationInput[] = [];
    for (const parameter of Array.isArray(operation.parameters) ? operation.parameters : []) {
        const resolved = resolveRef(parameter, schema);
        if (!isRecord(resolved) || typeof resolved.name !== 'string') continue;
        if (resolved.in !== 'path' && resolved.in !== 'query') continue;
        inputs.push({
            name: resolved.name,
            type: getTypeName(resolved.schema, schema),
            isRequired: resolved.in === 'path' || resolved.required === true,
        });
    }
    return inputs;
}

/** The JSON request body with the media type `parseRequestBody` picks; `undefined` when the operation takes none. */
function getRequestBody(operation: Record<string, unknown>, schema: unknown): { schema: unknown } | undefined {
    const requestBody = resolveRef(operation.requestBody, schema);
    if (!isRecord(requestBody) || !isRecord(requestBody.content)) return undefined;
    const { content } = requestBody;
    const media = content['application/json'] ?? content[Object.keys(content).find(isJsonMediaType) ?? '*/*'];
    return isRecord(media) ? { schema: media.schema } : undefined;
}

/** The top-level properties of a body schema; `undefined` when it lists none. */
function listBodyInputs(bodySchema: unknown, schema: unknown): OperationInput[] | undefined {
    const resolved = resolveOneRef(bodySchema, schema);
    if (!isRecord(resolved) || !isRecord(resolved.properties)) return undefined;
    const required = Array.isArray(resolved.required) ? resolved.required : [];
    const inputs = Object.entries(resolved.properties).map(([name, property]) => ({
        name,
        type: getTypeName(property, schema),
        isRequired: required.includes(name),
    }));
    return inputs.length > 0 ? inputs : undefined;
}

/** E.g. `q:string required, limit:integer`: required inputs first, then the others, up to `MAX_LISTED_INPUTS`. */
function formatInputs(inputs: OperationInput[]): string {
    const ordered = [...inputs.filter((input) => input.isRequired), ...inputs.filter((input) => !input.isRequired)];
    const listed = ordered
        .slice(0, MAX_LISTED_INPUTS)
        .map(({ name, type, isRequired }) => `${name}${type ? `:${type}` : ''}${isRequired ? ' required' : ''}`);
    const rest = ordered.length - listed.length;
    return [...listed, ...(rest > 0 ? [`+${rest} more`] : [])].join(', ');
}

/**
 * E.g. `- GET /search [q:string required, limit:integer]: Search the web.`, or
 * `- POST / {url:string required, formats:array}: Fetch a URL.` for a JSON body. Any other body, such as a JSON
 * schema that lists no properties or a form, reads `{request body}`, with `required` when it is.
 */
function formatOperationLine({ method, path, operation }: ServerOperation, schema: unknown): string {
    let text = `- ${method} ${path}`;
    const parameters = listParameterInputs(operation, schema);
    if (parameters.length > 0) text += ` [${formatInputs(parameters)}]`;
    const requestBody = resolveRef(operation.requestBody, schema);
    // An external or unresolved reference says nothing about the body.
    if (isRecord(requestBody) && requestBody.$ref === undefined) {
        const bodyInputs = listBodyInputs(getRequestBody(operation, schema)?.schema, schema);
        const isRequired = requestBody.required === true;
        text += bodyInputs ? ` {${formatInputs(bodyInputs)}}` : ` {request body${isRequired ? ' required' : ''}}`;
    }
    const { summary } = operation;
    if (typeof summary === 'string' && summary) text += `: ${summary}${/[.!?]$/.test(summary) ? '' : '.'}`;
    return text;
}

/**
 * The first lines of `count` operation lines within `maxSize`, as `sizeOf` measures it; when not all fit, the lines
 * that do, then `… and N more`. The cut line is kept even when no line fits.
 */
function cutOperationLines(
    lines: readonly string[],
    count: number,
    maxSize: number,
    sizeOf: (text: string) => number,
): string {
    const index = lines.join('\n');
    if (lines.length === count && sizeOf(index) <= maxSize) return index;
    // Room for the cut line with the largest count it can show.
    let size = sizeOf(`… and ${count} more`);
    const kept: string[] = [];
    for (const line of lines) {
        size += sizeOf(line) + 1;
        if (size > maxSize) break;
        kept.push(line);
    }
    return [...kept, `… and ${count - kept.length} more`].join('\n');
}

/** One line per operation; over `maxBytes`, the lines that fit, then `… and N more`. */
function formatOperationIndex(operations: ServerOperation[], schema: unknown, maxBytes: number): string {
    const lines = operations.map((operation) => formatOperationLine(operation, schema));
    return cutOperationLines(lines, lines.length, maxBytes, Buffer.byteLength);
}

/** A request body with no JSON media type: whether it is required and its media types, with no schema. */
function buildOtherRequestBody(rawRequestBody: unknown, schema: unknown) {
    const requestBody = resolveRef(rawRequestBody, schema);
    if (!isRecord(requestBody) || !isRecord(requestBody.content)) return undefined;
    const contentTypes = Object.keys(requestBody.content);
    if (contentTypes.length === 0) return undefined;
    return { isRequired: requestBody.required === true, contentTypes };
}

/**
 * One operation in the `get-apify-api-details` shape: local references inlined, examples kept, no responses.
 * The summary and description are left out when the schema has none. Throws `DereferenceBudgetError` when the
 * context's budget runs out.
 * A request body that is not JSON shows its content types instead of a schema.
 */
function buildServerOperationDetails({ method, path, operation }: ServerOperation, context: DereferenceContext) {
    const requestBody =
        parseRequestBody(operation.requestBody, context) ?? buildOtherRequestBody(operation.requestBody, context.spec);
    return {
        method,
        path,
        ...(typeof operation.summary === 'string' && { summary: operation.summary }),
        ...(typeof operation.description === 'string' && { description: operation.description }),
        parameters: parseParameters(Array.isArray(operation.parameters) ? operation.parameters : undefined, context),
        ...(requestBody && { requestBody }),
    };
}

/** `render` as fenced JSON; `undefined` when its references expand past `maxBytes`. */
function formatWithinBudget(
    schema: unknown,
    render: (context: DereferenceContext) => unknown,
    maxBytes = MAX_INLINE_BYTES,
): string | undefined {
    const budget = { remainingBytes: maxBytes };
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

/** What a request to the Actor's server interface costs, by tenancy. */
export function formatServerRequestCost(actor: Pick<Actor, 'actorStandby'>): string {
    const tenancy = resolveActorTenancy(actor);
    if (tenancy === ACTOR_TENANCY.MULTI_TENANT) {
        return `${tenancy}: requests are charged per event and start no run in your account.`;
    }
    const idleTimeoutSecs = actor.actorStandby?.idleTimeoutSecs;
    const idleTimeout = idleTimeoutSecs === undefined ? 'its idle timeout' : `its idle timeout of ${idleTimeoutSecs} s`;
    return `${tenancy}: the first request starts a run in your account, kept for ${idleTimeout}.`;
}

/** `undefined` text: the rendering ran out of its budget, so it would not fit. */
function checkSize(text: string | undefined, actorFullName: string): { text: string } | { error: string } {
    if (text !== undefined && Buffer.byteLength(text) <= MAX_INLINE_BYTES) return { text };
    return {
        error: `Actor '${actorFullName}' server-interface output exceeds the ${MAX_INLINE_BYTES}-byte limit and was not returned. A smaller operation may fit.`,
    };
}

/**
 * What a selected Server Actor's tool is built from; `undefined` for a schema with no operation. Its operations block
 * is the `serverInterface: true` rendering when that fits `SERVER_TOOL_OPERATIONS_MAX_BYTES`, otherwise one line per
 * operation (`formatOperationLine`), cut to fit with `… and N more`.
 */
export function buildServerActorToolInfo(schema: unknown, actorFullName: string): ServerActorToolInfo | undefined {
    const operations = listServerOperations(schema);
    if (operations.length === 0) return undefined;
    const surface = {
        methods: API_METHODS.filter((method) => operations.some((operation) => operation.method === method)),
        paths: [...new Set(operations.map(({ path }) => path))],
        hasRequestBody: operations.some(({ operation }) => getRequestBody(operation, schema) !== undefined),
    };
    const full = formatWithinBudget(
        schema,
        (context) => ({ operations: operations.map((operation) => buildServerOperationDetails(operation, context)) }),
        SERVER_TOOL_OPERATIONS_MAX_BYTES,
    );
    if (full !== undefined && Buffer.byteLength(full) <= SERVER_TOOL_OPERATIONS_MAX_BYTES) {
        return { ...surface, operations: full };
    }
    const { method, path } = operations[0];
    return {
        ...surface,
        operations: formatOperationIndex(operations, schema, SERVER_TOOL_OPERATIONS_MAX_BYTES),
        detailsHint: `${formatDetailsCall(actorFullName, `${method} ${path}`)} returns one operation in full.`,
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
    // A payment provider cannot pay for a request.
    const notice = hasPaymentProvider
        ? 'Requests to a server interface are not supported in agentic payment mode.'
        : formatServerRequestCost(actor);
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
