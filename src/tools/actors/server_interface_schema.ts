/**
 * The operations of a Server Actor's `webServerSchema`, an OpenAPI document as the creator wrote it, read the way
 * `apify_api_spec.ts` reads the Apify API. No prose and no tool names here.
 */
import type { ApiMethod, ApiOperation, ApiParameter, DereferenceContext } from '../api/apify_api_spec.js';
import {
    API_METHODS,
    isJsonMediaType,
    isRecord,
    parseParameters,
    parseRequestBody,
    resolveLocalRef,
} from '../api/apify_api_spec.js';

/** One method on one path, with the path-level parameters merged into the operation. */
export type ServerOperation = { method: ApiMethod; path: string; operation: Record<string, unknown> };

/** A body with no JSON media type cannot be sent, so it has no schema. */
export type OtherRequestBody = { isRequired: boolean; contentTypes: string[] };

/** The `get-apify-api-details` shape. */
export type ServerOperationDetails = Pick<ApiOperation, 'method' | 'path'> &
    Partial<Pick<ApiOperation, 'summary' | 'description'>> & {
        parameters: ApiParameter[];
        requestBody?: ApiOperation['requestBody'] | OtherRequestBody;
    };

export type ServerOperationIndexEntry = Pick<ApiOperation, 'method' | 'path'> &
    Partial<Pick<ApiOperation, 'summary'>> & { requiredInputs: string[] };

/** A path or query parameter, or a top-level property of a JSON request body. */
export type OperationInput = { name: string; type?: string; isRequired: boolean };

/**
 * The inputs of one operation. `requestBody.properties` is absent when the body is not JSON or its schema lists no
 * properties; `isJson` is false for a body the send tool cannot send.
 */
export type ServerOperationInputs = {
    parameters: OperationInput[];
    requestBody?: { isRequired: boolean; isJson: boolean; contentTypes: string[]; properties?: OperationInput[] };
};

/** Alias hops followed per parameter; real chains take one or two. */
const MAX_ALIAS_HOPS = 16;

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

export function listServerOperations(schema: unknown): ServerOperation[] {
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

export function formatOperationName({ method, path }: Pick<ServerOperation, 'method' | 'path'>): string {
    return `${method} ${path}`;
}

export function findServerOperation(operations: ServerOperation[], selector: string): ServerOperation | undefined {
    const match = /^\s*([A-Za-z]+)\s+(\S+)\s*$/.exec(selector);
    if (!match) return undefined;
    const [, method, path] = match;
    return operations.find((operation) => operation.method === method.toUpperCase() && operation.path === path);
}

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

export function buildServerOperationIndex(operations: ServerOperation[], schema: unknown): ServerOperationIndexEntry[] {
    return operations.map(({ method, path, operation }) => ({
        method,
        path,
        ...(typeof operation.summary === 'string' && { summary: operation.summary }),
        requiredInputs: listRequiredInputs(operation, schema),
    }));
}

export function listDocumentedOperations(
    schema: unknown,
    operations: ServerOperation[] = listServerOperations(schema),
): string[] {
    return buildServerOperationIndex(operations, schema).map((entry) => {
        const name = formatOperationName(entry);
        return entry.requiredInputs.length > 0 ? `${name} (required: ${entry.requiredInputs.join(', ')})` : name;
    });
}

function buildOtherRequestBody(rawRequestBody: unknown, schema: unknown): OtherRequestBody | undefined {
    const requestBody = resolveRef(rawRequestBody, schema);
    if (!isRecord(requestBody) || !isRecord(requestBody.content)) return undefined;
    const contentTypes = Object.keys(requestBody.content);
    if (contentTypes.length === 0) return undefined;
    return { isRequired: requestBody.required === true, contentTypes };
}

/** Throws `DereferenceBudgetError` when the context's budget runs out. */
export function buildServerOperationDetails(
    { method, path, operation }: ServerOperation,
    context: DereferenceContext,
): ServerOperationDetails {
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

/** Follows one local reference: an input reads a type without expanding schemas. */
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

/** The schema of the JSON media type `parseRequestBody` picks; `undefined` when there is none. */
function getJsonMediaSchema(content: Record<string, unknown>): { schema: unknown } | undefined {
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

/** An external or unresolved body reference says nothing about the body, so it has no `requestBody`. */
export function listOperationInputs({ operation }: ServerOperation, schema: unknown): ServerOperationInputs {
    const parameters = listParameterInputs(operation, schema);
    const requestBody = resolveRef(operation.requestBody, schema);
    if (!isRecord(requestBody) || requestBody.$ref !== undefined) return { parameters };
    const content = isRecord(requestBody.content) ? requestBody.content : {};
    const json = getJsonMediaSchema(content);
    const properties = json && listBodyInputs(json.schema, schema);
    return {
        parameters,
        requestBody: {
            isRequired: requestBody.required === true,
            isJson: json !== undefined,
            contentTypes: Object.keys(content),
            ...(properties && { properties }),
        },
    };
}
