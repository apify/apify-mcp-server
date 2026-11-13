import { describe, expect, it } from 'vitest';

import { HELPER_TOOLS, MAX_INLINE_BYTES } from '../../src/const.js';
import { buildFetchActorDetailsResult, fetchActorDetails } from '../../src/tools/actors/fetch_actor_details.js';
import type { ServerInterfaceDetails } from '../../src/tools/actors/server_interface_details.js';
import { buildServerInterfaceDetails } from '../../src/tools/actors/server_interface_details.js';
import type { Actor } from '../../src/types.js';
import { wrapJsonText } from '../../src/utils/encode_text.js';
import { mockActor, mockActorBuildClient, mockDefaultBuild } from './helpers/actor_build_client.js';
import {
    expectSchemaConformingStructuredContent,
    mockApifyClient,
    only,
    stubToolCallContext,
    textOf,
} from './helpers/tool_context.js';

const ACTOR_FULL_NAME = 'apify/server-actor-test';
const SERVER_URL = 'https://server-actor-test.apify.actor';
const DETAILS = `${HELPER_TOOLS.ACTOR_GET_DETAILS} with {"actor":"${ACTOR_FULL_NAME}","output":`;
const SUMMARY = 'Server interface: enabled, single-tenant, 3 documented operations: GET /add, POST /add, GET /empty.';
const LISTS_THEM = `${DETAILS}{"serverInterface":true}} lists them.`;
const SIZE_ERROR = `Actor '${ACTOR_FULL_NAME}' server-interface output exceeds the ${MAX_INLINE_BYTES}-byte limit and was not returned. A smaller operation may fit.`;
const SINGLE_TENANT_NOTICE =
    'single-tenant: the first request starts a run in your account, kept for its idle timeout of 300 s.\n';

/** The fixture's schema shapes: parameter, request body and response references. */
const SCHEMA: Record<string, unknown> = {
    openapi: '3.0.0',
    info: { title: 'Server Actor test', version: '1' },
    // The creator's servers are not the base URL.
    servers: [{ url: 'https://example-server-actor.apify.actor' }],
    paths: {
        '/add': {
            get: {
                summary: 'Add two numbers (query)',
                parameters: [
                    { name: 'firstNumber', in: 'query', required: true, schema: { type: 'integer' } },
                    { $ref: '#/components/parameters/AsText' },
                ],
                responses: { '200': { $ref: '#/components/responses/Add' } },
            },
            post: {
                summary: 'Add two numbers (JSON body)',
                requestBody: {
                    required: true,
                    content: { 'application/json': { schema: { $ref: '#/components/schemas/AddRequest' } } },
                },
                responses: { '200': { $ref: '#/components/responses/Add' } },
            },
            // The send tool does not send HEAD, so it is no operation.
            head: {},
        },
        '/empty': { get: { summary: 'Return no content', responses: { '204': { description: 'No content.' } } } },
    },
    components: {
        schemas: {
            AddRequest: { type: 'object', properties: { firstNumber: { type: 'integer' } }, required: ['firstNumber'] },
        },
        parameters: { AsText: { name: 'asText', in: 'query', required: false, schema: { type: 'boolean' } } },
        responses: { Add: { description: 'The sum.' } },
    },
};

/** SCHEMA's operations in the index. */
const SCHEMA_INDEX = [
    { method: 'GET', path: '/add', summary: 'Add two numbers (query)', requiredInputs: ['firstNumber'] },
    { method: 'POST', path: '/add', summary: 'Add two numbers (JSON body)', requiredInputs: ['request body'] },
    { method: 'GET', path: '/empty', summary: 'Return no content', requiredInputs: [] },
];

const WEB_FETCH = 'apify/web-fetch';

/** Shaped like apify/web-fetch's schema: query parameters that reference properties of the body schema, and examples. */
const WEB_FETCH_SCHEMA: Record<string, unknown> = {
    openapi: '3.0.0',
    info: { title: 'Web Fetch API', version: '0.1' },
    servers: [{ url: 'https://web-fetch.apify.actor' }],
    paths: {
        '/': {
            get: {
                summary: 'Fetch a URL',
                description: 'Fetches the resource at the URL.',
                'x-codegen-name': 'fetchGet',
                parameters: [
                    {
                        name: 'url',
                        in: 'query',
                        required: true,
                        schema: { $ref: '#/components/schemas/FetchRequest/properties/url' },
                        example: 'https://apify.com',
                    },
                    {
                        name: 'formats',
                        in: 'query',
                        schema: { $ref: '#/components/schemas/FetchRequest/properties/formats' },
                    },
                    // The send tool sends no headers.
                    { name: 'X-Trace', in: 'header', schema: { type: 'string' } },
                ],
                responses: { '200': { $ref: '#/components/responses/FetchSuccess' } },
            },
            post: {
                summary: 'Fetch a URL',
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/FetchRequest' },
                            example: { url: 'https://apify.com', formats: ['markdown'] },
                            examples: { html: { value: { url: 'https://apify.com', formats: ['html'] } } },
                        },
                    },
                },
                responses: { '200': { $ref: '#/components/responses/FetchSuccess' } },
            },
        },
    },
    components: {
        schemas: {
            FetchRequest: {
                type: 'object',
                required: ['url'],
                properties: {
                    url: { type: 'string', format: 'uri-reference', example: 'https://apify.com' },
                    formats: { type: 'array', items: { $ref: '#/components/schemas/Format' }, 'x-order': 2 },
                },
            },
            Format: { type: 'string', enum: ['markdown', 'html'] },
        },
        responses: { FetchSuccess: { description: 'The fetched content.' } },
    },
};

const URL_SCHEMA = { type: 'string', format: 'uri-reference', example: 'https://apify.com' };
const FORMATS_SCHEMA = { type: 'array', items: { type: 'string', enum: ['markdown', 'html'] } };

/** WEB_FETCH_SCHEMA in the get-apify-api-details shape: references inlined, examples kept, no responses or extensions. */
const WEB_FETCH_OPERATIONS = [
    {
        method: 'GET',
        path: '/',
        summary: 'Fetch a URL',
        description: 'Fetches the resource at the URL.',
        parameters: [
            { name: 'url', in: 'query', isRequired: true, schema: URL_SCHEMA, example: 'https://apify.com' },
            { name: 'formats', in: 'query', isRequired: false, schema: FORMATS_SCHEMA },
        ],
    },
    {
        // The schema gives no description, so the operation has none.
        method: 'POST',
        path: '/',
        summary: 'Fetch a URL',
        parameters: [],
        requestBody: {
            isRequired: true,
            schema: { type: 'object', required: ['url'], properties: { url: URL_SCHEMA, formats: FORMATS_SCHEMA } },
            example: { url: 'https://apify.com', formats: ['markdown'] },
            examples: { html: { value: { url: 'https://apify.com', formats: ['html'] } } },
        },
    },
];

function serverActor(overrides: Partial<Actor> = {}): Pick<Actor, 'actorStandby' | 'standbyUrl'> {
    return {
        actorStandby: { isEnabled: true, tenancy: 'SINGLE_TENANT', idleTimeoutSecs: 300 },
        standbyUrl: SERVER_URL,
        ...overrides,
    };
}

const MULTI_TENANT_ACTOR = serverActor({
    actorStandby: { isEnabled: true, tenancy: 'MULTI_TENANT', idleTimeoutSecs: 300 },
});

const required = (name: string) => ({ name, in: 'query', required: true });

/** SCHEMA with a description on GET /empty, which the operations in full carry and the index does not. */
function withDescriptionOnEmpty(description: string): Record<string, unknown> {
    const paths = SCHEMA.paths as Record<string, unknown>;
    return { ...SCHEMA, paths: { ...paths, '/empty': { get: { summary: 'Return no content', description } } } };
}

function build(params: Partial<Parameters<typeof buildServerInterfaceDetails>[0]> = {}) {
    return buildServerInterfaceDetails({
        actor: serverActor(),
        actorFullName: ACTOR_FULL_NAME,
        schema: SCHEMA,
        serverInterface: true,
        loadedToolNames: Object.values(HELPER_TOOLS),
        hasPaymentProvider: false,
        ...params,
    });
}

/** The section with both parts present, for the detail tiers. */
function sectionOf(params: Partial<Parameters<typeof buildServerInterfaceDetails>[0]> = {}): {
    serverInterface: ServerInterfaceDetails;
    text: string;
} {
    const result = build(params);
    if ('error' in result || !result.serverInterface || result.text === undefined) {
        throw new Error(`Expected a section: ${JSON.stringify(result)}`);
    }
    return { serverInterface: result.serverInterface, text: result.text };
}

describe('summarizing a server interface in one line', () => {
    const pathsOf = (paths: string[]) => ({ paths: Object.fromEntries(paths.map((path) => [path, { get: {} }])) });
    const fivePaths = ['/a', '/b', '/c', '/d', '/e'];
    it.each([
        [SCHEMA, 3, SUMMARY],
        [pathsOf(['/a']), 1, 'Server interface: enabled, single-tenant, 1 documented operation: GET /a.'],
        [
            pathsOf(fivePaths),
            5,
            'Server interface: enabled, single-tenant, 5 documented operations: GET /a, GET /b, GET /c, GET /d, GET /e.',
        ],
        [pathsOf([...fivePaths, '/f']), 6, 'Server interface: enabled, single-tenant, 6 documented operations.'],
        [pathsOf([`/${'a'.repeat(300)}`]), 1, 'Server interface: enabled, single-tenant, 1 documented operation.'],
    ])(
        'carries the tenancy and the operation count, naming the operations while few and short (%#)',
        (schema, operationCount, line) => {
            expect(build({ schema, serverInterface: false })).toEqual({
                serverInterface: { tenancy: 'single-tenant', operationCount },
                text: `${line} ${LISTS_THEM}`,
            });
        },
    );

    it.each([
        [false, {}],
        [true, { text: `Actor '${ACTOR_FULL_NAME}' has no server interface.` }],
    ])('for an Actor without one, with serverInterface %j, is %j', (serverInterface, section) => {
        expect(build({ serverInterface, actor: { actorStandby: { isEnabled: false } } })).toEqual(section);
    });

    it.each([
        [false, undefined],
        [true, { paths: {} }],
    ])('says the interface is undocumented, with serverInterface %j and schema %j', (serverInterface, schema) => {
        expect(build({ schema, serverInterface })).toEqual({
            serverInterface: { tenancy: 'single-tenant', operationCount: 0 },
            text: 'Server interface: enabled, single-tenant, undocumented: no API schema. See the README.',
        });
    });

    it('is left out of a session without the send tool', () => {
        expect(build({ serverInterface: false, loadedToolNames: [HELPER_TOOLS.ACTOR_GET_DETAILS] })).toEqual({});
    });
});

describe('the operations in full', () => {
    it('returns the tenancy and every operation in the get-apify-api-details shape, as the object and its JSON', () => {
        const { serverInterface, text } = sectionOf({
            actor: MULTI_TENANT_ACTOR,
            actorFullName: WEB_FETCH,
            schema: WEB_FETCH_SCHEMA,
        });

        // Multi-tenant: no idle timeout; with the send tool: no base URL.
        expect(serverInterface).toEqual({
            tenancy: 'multi-tenant',
            operationCount: 2,
            operations: WEB_FETCH_OPERATIONS,
        });
        expect(text).toBe(
            `# Server interface of ${WEB_FETCH}\n` +
                'multi-tenant: requests are charged per event and start no run in your account.\n' +
                `${HELPER_TOOLS.ACTOR_SERVER_REQUEST} sends a request to one of them: {"actor":"${WEB_FETCH}","method":"GET","path":"/"}\n` +
                wrapJsonText(serverInterface),
        );
    });

    it('merges path-level parameters, an operation parameter replacing the one with the same name', () => {
        const schema = {
            paths: {
                '/search': {
                    parameters: [
                        { $ref: '#/components/parameters/Query' },
                        { name: 'limit', in: 'query', schema: { type: 'integer' } },
                    ],
                    get: { parameters: [{ name: 'q', in: 'query', description: 'Search terms.' }] },
                },
            },
            components: { parameters: { Query: required('q') } },
        };

        expect(sectionOf({ schema }).serverInterface.operations?.[0].parameters).toEqual([
            { name: 'q', in: 'query', isRequired: false, description: 'Search terms.' },
            { name: 'limit', in: 'query', isRequired: false, schema: { type: 'integer' } },
        ]);
    });

    const formBody = { required: true, content: { 'multipart/form-data': { schema: { type: 'object' } } } };
    // The index says the body is required, so the full rendering must show it, though it has no JSON schema.
    it.each([
        ['inline', formBody, {}],
        ['through a reference', { $ref: '#/components/requestBodies/Upload' }, { Upload: formBody }],
    ])('shows the content types of a request body that is not JSON, %s', (_label, requestBody, requestBodies) => {
        const schema = { paths: { '/upload': { post: { requestBody } } }, components: { requestBodies } };

        expect(sectionOf({ schema }).serverInterface.operations?.[0].requestBody).toEqual({
            isRequired: true,
            contentTypes: ['multipart/form-data'],
        });
    });

    it('says requests are not supported, without the send tool or run cost, in agentic payment mode', () => {
        const { text } = sectionOf({ hasPaymentProvider: true });

        expect(text).toContain('Requests to a server interface are not supported in agentic payment mode.\n');
        expect(text).not.toContain(HELPER_TOOLS.ACTOR_SERVER_REQUEST);
        expect(text).not.toContain('starts a run');
    });

    it("gives the Actor's server interface URL as the base URL instead of the send tool when the session lacks it", () => {
        const { serverInterface, text } = sectionOf({ loadedToolNames: [HELPER_TOOLS.ACTOR_GET_DETAILS] });

        expect(serverInterface.baseUrl).toBe(SERVER_URL);
        expect(text).not.toContain(HELPER_TOOLS.ACTOR_SERVER_REQUEST);
        expect(text).not.toContain('example-server-actor');
    });

    // At the limit the operations fit in full; one byte over, the section is the index.
    it.each([0, 1])('counts the whole text against the byte limit, %i byte over', (over) => {
        const fullBytes = Buffer.byteLength(sectionOf({ schema: withDescriptionOnEmpty('') }).text);

        const { serverInterface } = sectionOf({
            schema: withDescriptionOnEmpty('a'.repeat(MAX_INLINE_BYTES - fullBytes + over)),
        });

        expect('operations' in serverInterface).toBe(over === 0);
        expect('operationIndex' in serverInterface).toBe(over === 1);
    });

    it('counts UTF-8 bytes, not characters, against the byte limit', () => {
        const { serverInterface } = sectionOf({
            schema: withDescriptionOnEmpty('漢'.repeat(Math.ceil(MAX_INLINE_BYTES / 3))),
        });

        expect(serverInterface.operations).toBeUndefined();
        expect(serverInterface.operationIndex).toHaveLength(3);
    });
});

describe('the operation index, when the operations in full exceed the byte limit', () => {
    it('lists each operation with its summary and required inputs, and the call that returns one in full', () => {
        const { serverInterface, text } = sectionOf({ schema: withDescriptionOnEmpty('a'.repeat(MAX_INLINE_BYTES)) });

        expect(serverInterface).toEqual({
            tenancy: 'single-tenant',
            idleTimeoutSecs: 300,
            operationCount: 3,
            operationIndex: SCHEMA_INDEX,
        });
        expect(text).toBe(
            `# Server interface of ${ACTOR_FULL_NAME}\n` +
                SINGLE_TENANT_NOTICE +
                `${HELPER_TOOLS.ACTOR_SERVER_REQUEST} sends a request to one of them: {"actor":"${ACTOR_FULL_NAME}","method":"GET","path":"/add"}\n` +
                `The operations in full exceed the ${MAX_INLINE_BYTES}-byte limit. ` +
                `${DETAILS}{"serverInterface":"GET /add"}} returns one operation in full.\n` +
                wrapJsonText(serverInterface),
        );
    });

    const chain: Record<string, unknown> = { P100: required('deep') };
    for (let i = 0; i < 100; i++) chain[`P${i}`] = { $ref: `#/components/parameters/P${i + 1}` };
    // Each row: the `get` operation and `components.parameters` under a path-level `Alias` parameter.
    it.each([
        [
            'reads required inputs through an alias chain and escaped pointer segments',
            {},
            { Alias: { $ref: '#/components/parameters/Search~1query~0' }, 'Search/query~': required('q') },
            { requiredInputs: ['q'] },
        ],
        [
            'replaces an aliased path-level parameter by its operation-level override',
            { summary: 'Search', parameters: [{ name: 'q', in: 'query' }] },
            { Alias: { $ref: '#/components/parameters/Search' }, Search: required('q') },
            { summary: 'Search', requiredInputs: [] },
        ],
        [
            'skips circular, missing and external aliases, and a chain over the hop cap',
            {
                parameters: [
                    ...['Loop', 'Missing', 'P0'].map((name) => ({ $ref: `#/components/parameters/${name}` })),
                    required('q'),
                ],
                requestBody: { $ref: 'https://example.com/body.json' },
            },
            {
                Alias: { $ref: 'https://example.com/parameter.json' },
                Loop: { $ref: '#/components/parameters/Loop' },
                ...chain,
            },
            { requiredInputs: ['q'] },
        ],
    ])('%s', (_label, get, parameters, entry) => {
        const description = 'a'.repeat(MAX_INLINE_BYTES);
        const schema = {
            paths: {
                '/search': { parameters: [{ $ref: '#/components/parameters/Alias' }], get: { ...get, description } },
            },
            components: { parameters },
        };

        expect(sectionOf({ schema }).serverInterface.operationIndex).toEqual([
            { method: 'GET', path: '/search', ...entry },
        ]);
    });

    it('cuts the index at the byte limit and counts the operations left out', () => {
        const count = 1000;
        const paths = Object.fromEntries(
            Array.from({ length: count }, (_, i) => [`/${String(i).padStart(4, '0')}${'a'.repeat(300)}`, { get: {} }]),
        );

        const { serverInterface, text } = sectionOf({ schema: { paths } });

        const kept = serverInterface.operationIndex!.length;
        expect(kept).toBeGreaterThan(0);
        expect(serverInterface.omittedOperationCount).toBe(count - kept);
        expect(text.endsWith(wrapJsonText(serverInterface))).toBe(true);
        // No room is left for one more entry; they are all the same size.
        const entryBytes = Buffer.byteLength(`,${JSON.stringify(serverInterface.operationIndex![0])}`);
        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_INLINE_BYTES);
        expect(Buffer.byteLength(text) + entryBytes).toBeGreaterThan(MAX_INLINE_BYTES);
    });
});

/** A schema whose POST /nested body has the JSON media type object `media`, with `schemas` as its components. */
function nestedBodySchema(media: Record<string, unknown>, schemas: Record<string, unknown> = {}) {
    const requestBody = { required: true, content: { 'application/json': media } };
    return { paths: { '/nested': { post: { summary: 'Nest', requestBody } } }, components: { schemas } };
}

// Each level references the next ten times: 10^30 nodes in full.
const exponentialSchemas: Record<string, unknown> = { L30: { type: 'string' } };
for (let level = 0; level < 30; level++) {
    const properties = Array.from({ length: 10 }, (_, i) => [`p${i}`, { $ref: `#/components/schemas/L${level + 1}` }]);
    exponentialSchemas[`L${level}`] = { type: 'object', properties: Object.fromEntries(properties) };
}
// 3000 distinct references, each to the next.
const chainSchemas: Record<string, unknown> = { C3000: { type: 'string' } };
for (let i = 0; i < 3000; i++) chainSchemas[`C${i}`] = { $ref: `#/components/schemas/C${i + 1}` };
// 5000 levels of inline nesting, no references.
let deepSchema: unknown = { type: 'string' };
for (let i = 0; i < 5000; i++) deepSchema = { type: 'array', items: deepSchema };
// 60000 levels: deeper than JSON.stringify can serialize on Node.js 24, and over the byte limit on Node.js 26, which can.
let deepValue: unknown = 'leaf';
for (let i = 0; i < 60000; i++) deepValue = { a: deepValue };

// Without a bound, rendering would not finish or would overflow the stack.
describe.each([
    [
        'references that expand exponentially',
        nestedBodySchema({ schema: { $ref: '#/components/schemas/L0' } }, exponentialSchemas),
    ],
    ['a long reference chain', nestedBodySchema({ schema: { $ref: '#/components/schemas/C0' } }, chainSchemas)],
    ['deep inline nesting', nestedBodySchema({ schema: deepSchema })],
    [
        'a reference to deep inline nesting',
        nestedBodySchema({ schema: { $ref: '#/components/schemas/Deep' } }, { Deep: deepValue }),
    ],
    ['a deeply nested example', nestedBodySchema({ schema: { type: 'object' }, example: deepValue })],
])('a schema with %s', (_label, schema) => {
    it('falls back to the index for all operations', () => {
        expect(sectionOf({ schema }).serverInterface.operationIndex).toEqual([
            { method: 'POST', path: '/nested', summary: 'Nest', requiredInputs: ['request body'] },
        ]);
    });

    it('is a size error for one operation', () => {
        expect(build({ schema, serverInterface: 'POST /nested' })).toEqual({ error: SIZE_ERROR });
    });
});

describe('one operation', () => {
    it('returns the selected operation, of any method case, in full, with the count of all operations', () => {
        const { serverInterface, text } = sectionOf({
            actor: MULTI_TENANT_ACTOR,
            actorFullName: WEB_FETCH,
            schema: WEB_FETCH_SCHEMA,
            serverInterface: 'post /',
        });

        expect(serverInterface).toEqual({
            tenancy: 'multi-tenant',
            operationCount: 2,
            operations: [WEB_FETCH_OPERATIONS[1]],
        });
        expect(text).toBe(
            `# Server interface of ${WEB_FETCH}: POST /\n` +
                'multi-tenant: requests are charged per event and start no run in your account.\n' +
                `${HELPER_TOOLS.ACTOR_SERVER_REQUEST} sends this request: {"actor":"${WEB_FETCH}","method":"POST","path":"/"}\n` +
                wrapJsonText(serverInterface),
        );
    });

    it('returns an operation when all operations together exceed the byte limit', () => {
        const { serverInterface } = sectionOf({
            schema: withDescriptionOnEmpty('a'.repeat(MAX_INLINE_BYTES)),
            serverInterface: 'POST /add',
        });

        expect(serverInterface.operations?.[0].requestBody).toMatchObject({
            schema: (SCHEMA.components as Record<string, Record<string, unknown>>).schemas.AddRequest,
        });
    });
});

describe('a selection that cannot be returned', () => {
    const unknown = `3 documented operations: GET /add, POST /add, GET /empty. ${LISTS_THEM}`;
    it.each([
        ['GET /nope', `has no operation "GET /nope". ${unknown}`],
        ['add', `has no operation "add". ${unknown}`],
        // The JSON pointer form is gone: a pointer is an unknown operation.
        ['#/components/schemas/AddRequest', `has no operation "#/components/schemas/AddRequest". ${unknown}`],
    ])('is an error for %j', (serverInterface, error) => {
        expect(build({ serverInterface })).toEqual({ error: `Actor '${ACTOR_FULL_NAME}' ${error}` });
    });

    it('names no operation in the error for an unknown one when the names are long', () => {
        const schema = { paths: { [`/${'a'.repeat(300)}`]: { get: {} } } };

        expect(build({ schema, serverInterface: 'GET /nope' })).toEqual({
            error: `Actor '${ACTOR_FULL_NAME}' has no operation "GET /nope". 1 documented operation. ${LISTS_THEM}`,
        });
    });

    it('is a size error, no partial JSON, for one operation over the byte limit', () => {
        const schema = { paths: { '/search': { get: { summary: 'a'.repeat(MAX_INLINE_BYTES) } } } };

        expect(build({ schema, serverInterface: 'GET /search' })).toEqual({ error: SIZE_ERROR });
    });
});

describe('the tool description', () => {
    it('promises the summary line only when the session has send-server-actor-request', () => {
        const withSend = fetchActorDetails.buildDescription!(only(HELPER_TOOLS.ACTOR_SERVER_REQUEST));
        const withoutSend = fetchActorDetails.buildDescription!(only());

        expect(withSend).toContain('one-line server interface summary');
        expect(withoutSend).not.toContain('server interface summary');
        expect(withoutSend).toContain('outputSchema and serverInterface.\n');
    });
});

describe('fetching details of a Server Actor', () => {
    const call = async (
        output?: Record<string, unknown>,
        {
            hasPaymentProvider = false,
            loadedToolNames = [HELPER_TOOLS.ACTOR_CALL, HELPER_TOOLS.ACTOR_SERVER_REQUEST],
        }: { hasPaymentProvider?: boolean; loadedToolNames?: string[] } = {},
    ) => {
        const { apifyClient } = mockActorBuildClient({
            actor: mockActor({ id: 'server-actor-id', name: 'server-actor-test', username: 'apify', ...serverActor() }),
            defaultBuild: mockDefaultBuild({ webServerSchema: SCHEMA, webServerMcpPath: undefined }),
            hasToken: false,
        });
        const client = mockApifyClient({
            ...apifyClient,
            store: () => ({
                list: async () => ({ total: 0, count: 0, offset: 0, limit: 10, desc: false, items: [] }),
            }),
        });
        const context = stubToolCallContext({ actor: ACTOR_FULL_NAME, ...(output && { output }) }, client, {
            loadedToolNames,
        });
        context.apifyToken = '';
        // The provider is not consumed here; only its presence disables server requests.
        if (hasPaymentProvider) context.paymentProvider = {} as never;
        return buildFetchActorDetailsResult(context);
    };

    it.each([
        [undefined, SUMMARY, { tenancy: 'single-tenant', operationCount: 3 }],
        [{ inputSchema: true }, SUMMARY, { tenancy: 'single-tenant', operationCount: 3 }],
        [
            { serverInterface: true },
            `# Server interface of ${ACTOR_FULL_NAME}\n`,
            { tenancy: 'single-tenant', idleTimeoutSecs: 300, operationCount: 3, operations: expect.any(Array) },
        ],
        [
            { serverInterface: 'GET /empty' },
            `# Server interface of ${ACTOR_FULL_NAME}: GET /empty\n`,
            {
                tenancy: 'single-tenant',
                idleTimeoutSecs: 300,
                operationCount: 3,
                operations: [{ method: 'GET', path: '/empty', summary: 'Return no content', parameters: [] }],
            },
        ],
    ])(
        'carries the server interface in the text and, schema-conforming, in structuredContent of output %j',
        async (output, expectedText, expectedObject) => {
            const result = await call(output);

            expect(textOf(result.content!.at(-1)!)).toContain(expectedText);
            expect((result.structuredContent as { serverInterface?: unknown }).serverInterface).toEqual(expectedObject);
            expectSchemaConformingStructuredContent(result, fetchActorDetails.outputSchema!);
        },
    );

    it('leaves the summary line out when the session cannot send requests', async () => {
        const result = await call(undefined, { loadedToolNames: [HELPER_TOOLS.ACTOR_CALL] });

        expect(JSON.stringify(result.content)).not.toContain('Server interface:');
        expect((result.structuredContent as { serverInterface?: unknown }).serverInterface).toBeUndefined();
    });

    it('returns the selection error for an unknown operation', async () => {
        const result = await call({ serverInterface: 'GET /nope' });

        expect(result.isError).toBe(true);
        expect(textOf(result.content![0])).toContain('3 documented operations: GET /add, POST /add, GET /empty.');
    });

    it('says requests are not supported in agentic payment mode', async () => {
        const result = await call({ serverInterface: true }, { hasPaymentProvider: true });

        expect(textOf(result.content!.at(-1)!)).toContain('not supported in agentic payment mode');
    });
});
