import { describe, expect, it } from 'vitest';

import { HELPER_TOOLS, MAX_INLINE_BYTES } from '../../src/const.js';
import { buildFetchActorDetailsResult, fetchActorDetails } from '../../src/tools/actors/fetch_actor_details.js';
import { buildServerInterfaceText } from '../../src/tools/actors/server_interface_schema.js';
import type { Actor } from '../../src/types.js';
import { mockActor, mockActorBuildClient, mockDefaultBuild } from './helpers/actor_build_client.js';
import { mockApifyClient, only, stubToolCallContext, textOf } from './helpers/tool_context.js';

const ACTOR_FULL_NAME = 'apify/server-actor-test';
const STANDBY_URL = 'https://server-actor-test.apify.actor';
const DETAILS = `${HELPER_TOOLS.ACTOR_GET_DETAILS} with {"actor":"${ACTOR_FULL_NAME}","output":`;
const SUMMARY = 'Server interface: enabled, single-tenant, 3 documented operations: GET /add, POST /add, GET /empty.';
const LISTS_THEM = `${DETAILS}{"serverInterface":true}} lists them.`;
const SIZE_ERROR = `Actor '${ACTOR_FULL_NAME}' server-interface output exceeds the ${MAX_INLINE_BYTES}-byte limit and was not returned. A smaller operation may fit.`;

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
        standbyUrl: STANDBY_URL,
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

function build(params: Partial<Parameters<typeof buildServerInterfaceText>[0]> = {}) {
    return buildServerInterfaceText({
        actor: serverActor(),
        actorFullName: ACTOR_FULL_NAME,
        schema: SCHEMA,
        serverInterface: true,
        loadedToolNames: Object.values(HELPER_TOOLS),
        hasPaymentProvider: false,
        ...params,
    });
}

function textOfBuild(params: Partial<Parameters<typeof buildServerInterfaceText>[0]> = {}): string {
    const result = build(params);
    if (!('text' in result) || result.text === undefined) throw new Error(`Expected a text: ${JSON.stringify(result)}`);
    return result.text;
}

/** Parses the fenced JSON block a text ends with. */
function parseJsonBlock(text: string) {
    expect(text.endsWith('\n```')).toBe(true);
    return JSON.parse(text.slice(text.indexOf('```json\n') + '```json\n'.length, text.lastIndexOf('\n```')));
}

describe('summarizing a server interface in one line', () => {
    const pathsOf = (paths: string[]) => ({ paths: Object.fromEntries(paths.map((path) => [path, { get: {} }])) });
    const fivePaths = ['/a', '/b', '/c', '/d', '/e'];
    it.each([
        [SCHEMA, SUMMARY],
        [pathsOf(['/a']), 'Server interface: enabled, single-tenant, 1 documented operation: GET /a.'],
        [
            pathsOf(fivePaths),
            'Server interface: enabled, single-tenant, 5 documented operations: GET /a, GET /b, GET /c, GET /d, GET /e.',
        ],
        [pathsOf([...fivePaths, '/f']), 'Server interface: enabled, single-tenant, 6 documented operations.'],
        [pathsOf([`/${'a'.repeat(300)}`]), 'Server interface: enabled, single-tenant, 1 documented operation.'],
    ])(
        'states the tenancy, the operations by name while few and short, and the call that lists them (%#)',
        (schema, line) => {
            expect(build({ schema, serverInterface: false })).toEqual({ text: `${line} ${LISTS_THEM}` });
        },
    );

    it.each([
        [false, undefined],
        [true, `Actor '${ACTOR_FULL_NAME}' has no server interface.`],
    ])('for an Actor without one, with serverInterface %j, is %j', (serverInterface, text) => {
        expect(build({ serverInterface, actor: { actorStandby: { isEnabled: false } } })).toEqual({ text });
    });

    it.each([
        [false, undefined],
        [true, { paths: {} }],
    ])('says the interface is undocumented, with serverInterface %j and schema %j', (serverInterface, schema) => {
        expect(build({ schema, serverInterface })).toEqual({
            text: 'Server interface: enabled, single-tenant, undocumented: no API schema. See the README.',
        });
    });
});

describe('the operations in full', () => {
    it('returns the header, the call to send, and every operation in the get-apify-api-details shape', () => {
        const text = textOfBuild({ actor: MULTI_TENANT_ACTOR, actorFullName: WEB_FETCH, schema: WEB_FETCH_SCHEMA });

        expect(text.slice(0, text.indexOf('```json'))).toBe(
            `# Server interface of ${WEB_FETCH}\n` +
                'multi-tenant: requests are charged per event and start no run in your account.\n' +
                `${HELPER_TOOLS.ACTOR_SERVER_REQUEST} sends a request to one of them: {"actor":"${WEB_FETCH}","method":"GET","path":"/"}\n` +
                'Operations (2):\n',
        );
        expect(parseJsonBlock(text)).toEqual({ operations: WEB_FETCH_OPERATIONS });
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

        expect(parseJsonBlock(textOfBuild({ schema })).operations[0].parameters).toEqual([
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

        expect(parseJsonBlock(textOfBuild({ schema })).operations[0].requestBody).toEqual({
            isRequired: true,
            contentTypes: ['multipart/form-data'],
        });
    });

    it('says requests are not supported, without the send tool or run cost, in agentic payment mode', () => {
        const text = textOfBuild({ hasPaymentProvider: true });

        expect(text).toContain('Requests to a server interface are not supported in agentic payment mode.\n');
        expect(text).not.toContain(HELPER_TOOLS.ACTOR_SERVER_REQUEST);
        expect(text).not.toContain('starts a run');
    });

    it("gives the Actor's standby URL as the base URL instead of the send tool when the session lacks it", () => {
        const text = textOfBuild({ loadedToolNames: [HELPER_TOOLS.ACTOR_GET_DETAILS] });

        expect(text).not.toContain(HELPER_TOOLS.ACTOR_SERVER_REQUEST);
        expect(text).toContain(`Base URL: ${STANDBY_URL}`);
        expect(text).not.toContain('example-server-actor');
    });

    // At the limit the operations fit in full; one byte over, the text is the index.
    it.each([0, 1])('counts the whole text against the byte limit, %i byte over', (over) => {
        const fullBytes = Buffer.byteLength(textOfBuild({ schema: withDescriptionOnEmpty('') }));

        const text = textOfBuild({ schema: withDescriptionOnEmpty('a'.repeat(MAX_INLINE_BYTES - fullBytes + over)) });

        expect(text.includes('```json')).toBe(over === 0);
        expect(text.includes('- POST /add')).toBe(over === 1);
    });

    it('counts UTF-8 bytes, not characters, against the byte limit', () => {
        const text = textOfBuild({ schema: withDescriptionOnEmpty('漢'.repeat(Math.ceil(MAX_INLINE_BYTES / 3))) });

        expect(text).not.toContain('```json');
        expect(text).toContain('- POST /add');
    });
});

describe('the operation index, when the operations in full exceed the byte limit', () => {
    it('lists each operation with its inputs and summary, and the call that returns one in full', () => {
        expect(textOfBuild({ schema: withDescriptionOnEmpty('a'.repeat(MAX_INLINE_BYTES)) })).toBe(
            `# Server interface of ${ACTOR_FULL_NAME}\n` +
                'single-tenant: the first request starts a run in your account, kept for its idle timeout of 300 s.\n' +
                `${HELPER_TOOLS.ACTOR_SERVER_REQUEST} sends a request to one of them: {"actor":"${ACTOR_FULL_NAME}","method":"GET","path":"/add"}\n` +
                'Operations (3):\n' +
                '- GET /add [firstNumber:integer required, asText:boolean]: Add two numbers (query).\n' +
                '- POST /add {firstNumber:integer required}: Add two numbers (JSON body).\n' +
                '- GET /empty: Return no content.\n' +
                `The operations in full exceed the ${MAX_INLINE_BYTES}-byte limit. ` +
                `${DETAILS}{"serverInterface":"GET /add"}} returns one operation in full.`,
        );
    });

    const chain: Record<string, unknown> = { P100: required('deep') };
    for (let i = 0; i < 100; i++) chain[`P${i}`] = { $ref: `#/components/parameters/P${i + 1}` };
    // Each row: the `get` operation and `components.parameters` under a path-level `Alias` parameter.
    it.each([
        [
            'keeps one period after a summary that ends with one',
            { summary: 'Hi.', parameters: [required('q')] },
            {},
            ' [q required]: Hi.\n',
        ],
        [
            'reads required inputs through an alias chain and escaped pointer segments',
            {},
            { Alias: { $ref: '#/components/parameters/Search~1query~0' }, 'Search/query~': required('q') },
            ' [q required]\n',
        ],
        [
            'replaces an aliased path-level parameter by its operation-level override',
            { summary: 'Search', parameters: [{ name: 'q', in: 'query' }] },
            { Alias: { $ref: '#/components/parameters/Search' }, Search: required('q') },
            ' [q]: Search.\n',
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
            ' [q required]\n',
        ],
    ])('%s', (_label, get, parameters, line) => {
        const description = 'a'.repeat(MAX_INLINE_BYTES);
        const schema = {
            paths: {
                '/search': { parameters: [{ $ref: '#/components/parameters/Alias' }], get: { ...get, description } },
            },
            components: { parameters },
        };

        expect(textOfBuild({ schema })).toContain(`- GET /search${line}`);
    });

    /** The index line of the one path item `pathItem`, with a description long enough to force the index. */
    const indexLineOf = (pathItem: Record<string, unknown>, components: Record<string, unknown> = {}) => {
        const description = 'a'.repeat(MAX_INLINE_BYTES);
        const operations = Object.fromEntries(
            Object.entries(pathItem).map(([method, operation]) => [method, { ...(operation as object), description }]),
        );
        const text = textOfBuild({ schema: { paths: { '/items/{id}': operations }, components } });
        return text.split('\n').find((line) => line.startsWith('- '));
    };

    it('lists required parameters first, then the others in schema order, up to five, then counts the rest', () => {
        const optional = (name: string) => ({ name, in: 'query', schema: { type: ['string', 'null'] } });
        const parameters = [
            optional('a'),
            { name: 'trace', in: 'header', required: true },
            { name: 'id', in: 'path', schema: { $ref: '#/components/schemas/Id' } },
            optional('b'),
            { ...required('q'), schema: { type: 'string' } },
            optional('c'),
            optional('d'),
        ];

        // A header parameter is never sent, and a path parameter is always required.
        expect(indexLineOf({ get: { parameters } }, { schemas: { Id: { type: 'integer' } } })).toBe(
            '- GET /items/{id} [id:integer required, q:string required, a:string|null, b:string|null, c:string|null, +1 more]',
        );
    });

    it('lists the top-level properties of a JSON body the same way, without expanding nested objects', () => {
        const properties = Object.fromEntries(
            ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map((name) => [name, { $ref: '#/components/schemas/Nested' }]),
        );
        const requestBody = { content: { 'application/json': { schema: { $ref: '#/components/schemas/Body' } } } };
        const schemas = {
            Body: { type: 'object', required: ['p6'], properties },
            Nested: { type: 'object', properties: { deep: { type: 'string' } } },
        };

        expect(indexLineOf({ put: { summary: 'Update', requestBody } }, { schemas })).toBe(
            '- PUT /items/{id} {p6:object required, p1:object, p2:object, p3:object, p4:object, +1 more}: Update.',
        );
    });

    it('marks a JSON body whose schema lists no properties, and whether it is required', () => {
        const body = (isRequired: boolean) => ({
            required: isRequired,
            content: { 'text/plain': {}, 'application/vnd.api+json': { schema: { type: 'array' } } },
        });

        expect(indexLineOf({ post: { requestBody: body(true) } })).toBe('- POST /items/{id} {request body required}');
        expect(indexLineOf({ post: { requestBody: body(false) } })).toBe('- POST /items/{id} {request body}');
    });

    it('cuts the index at the byte limit and counts the operations left out', () => {
        const count = 1000;
        const paths = Object.fromEntries(
            Array.from({ length: count }, (_, i) => [`/${String(i).padStart(4, '0')}${'a'.repeat(300)}`, { get: {} }]),
        );

        const text = textOfBuild({ schema: { paths } });

        const lines = text.split('\n').filter((line) => line.startsWith('- GET /'));
        expect(text).toContain(`${lines.at(-1)}\n… and ${count - lines.length} more\n`);
        expect(text.endsWith('returns one operation in full.')).toBe(true);
        // No room is left for one more line.
        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_INLINE_BYTES);
        expect(Buffer.byteLength(text) + Buffer.byteLength(`${lines[0]}\n`)).toBeGreaterThan(MAX_INLINE_BYTES);
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
        expect(textOfBuild({ schema })).toMatch(/\n- POST \/nested \{[^\n]+\}: Nest\.\nThe operations in full/);
    });

    it('is a size error for one operation', () => {
        expect(build({ schema, serverInterface: 'POST /nested' })).toEqual({ error: SIZE_ERROR });
    });
});

describe('one operation', () => {
    it('returns the selected operation, of any method case, in full', () => {
        const text = textOfBuild({
            actor: MULTI_TENANT_ACTOR,
            actorFullName: WEB_FETCH,
            schema: WEB_FETCH_SCHEMA,
            serverInterface: 'post /',
        });

        expect(text.slice(0, text.indexOf('```json'))).toBe(
            `# Server interface of ${WEB_FETCH}: POST /\n` +
                'multi-tenant: requests are charged per event and start no run in your account.\n' +
                `${HELPER_TOOLS.ACTOR_SERVER_REQUEST} sends this request: {"actor":"${WEB_FETCH}","method":"POST","path":"/"}\n`,
        );
        expect(parseJsonBlock(text)).toEqual(WEB_FETCH_OPERATIONS[1]);
    });

    it('returns an operation when all operations together exceed the byte limit', () => {
        const text = textOfBuild({
            schema: withDescriptionOnEmpty('a'.repeat(MAX_INLINE_BYTES)),
            serverInterface: 'POST /add',
        });

        expect(parseJsonBlock(text).requestBody.schema).toEqual(
            (SCHEMA.components as Record<string, Record<string, unknown>>).schemas.AddRequest,
        );
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
            defaultBuild: mockDefaultBuild({ webServerSchema: SCHEMA }),
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
        [undefined, SUMMARY],
        [{ inputSchema: true }, SUMMARY],
        [{ serverInterface: true }, `# Server interface of ${ACTOR_FULL_NAME}\n`],
    ])('carries the server interface in the text and structuredContent of output %j', async (output, expected) => {
        const result = await call(output);

        const text = textOf(result.content!.at(-1)!);
        expect(text).toContain(expected);
        expect((result.structuredContent as { serverInterface?: string }).serverInterface).toBe(text);
    });

    it('leaves the summary line out when the session cannot send requests', async () => {
        const result = await call(undefined, { loadedToolNames: [HELPER_TOOLS.ACTOR_CALL] });

        expect(JSON.stringify(result.content)).not.toContain('Server interface:');
        expect((result.structuredContent as { serverInterface?: string }).serverInterface).toBeUndefined();
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
