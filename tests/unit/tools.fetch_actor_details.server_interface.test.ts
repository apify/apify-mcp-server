import { describe, expect, it } from 'vitest';

import { HELPER_TOOLS, MAX_INLINE_BYTES } from '../../src/const.js';
import { buildFetchActorDetailsResult } from '../../src/tools/actors/fetch_actor_details.js';
import { buildServerInterfaceText } from '../../src/tools/actors/server_interface_schema.js';
import type { Actor } from '../../src/types.js';
import { mockActor, mockActorBuildClient, mockDefaultBuild } from './helpers/actor_build_client.js';
import { mockApifyClient, stubToolCallContext, textOf } from './helpers/tool_context.js';

const ACTOR_FULL_NAME = 'apify/server-actor-test';
const STANDBY_URL = 'https://server-actor-test.apify.actor';
const DETAILS = `${HELPER_TOOLS.ACTOR_GET_DETAILS} with {"actor":"${ACTOR_FULL_NAME}","output":`;
const SUMMARY = 'Server interface: enabled, single-tenant, 3 documented operations: GET /add, POST /add, GET /empty.';

/** The fixture's schema shapes: parameter, request body and response references, like apify/web-fetch's `FetchRequest`. */
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
            'Forbidden/~': false,
        },
        parameters: { AsText: { name: 'asText', in: 'query', required: false, schema: { type: 'boolean' } } },
        responses: { Add: { description: 'The sum.' } },
    },
};

function serverActor(overrides: Partial<Actor> = {}): Pick<Actor, 'actorStandby' | 'standbyUrl'> {
    return {
        actorStandby: { isEnabled: true, tenancy: 'SINGLE_TENANT', idleTimeoutSecs: 300 },
        standbyUrl: STANDBY_URL,
        ...overrides,
    };
}

const required = (name: string) => ({ name, in: 'query', required: true });

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
    return JSON.parse(text.slice(text.indexOf('```json\n') + '```json\n'.length, text.lastIndexOf('\n```')));
}

describe('summarizing a server interface in one line', () => {
    const sixPaths = Object.fromEntries(['/a', '/b', '/c', '/d', '/e', '/f'].map((path) => [path, { get: {} }]));
    it.each([
        [SCHEMA, SUMMARY],
        [{ paths: sixPaths }, 'Server interface: enabled, single-tenant, 6 documented operations.'],
    ])('states the tenancy, the operations, up to five by name, and the call that lists them (%#)', (schema, line) => {
        expect(build({ schema, serverInterface: false })).toEqual({
            text: `${line} ${DETAILS}{"serverInterface":true}} lists them.`,
        });
    });

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

describe('the operation list', () => {
    it('lists each operation with its summary and required inputs, the calls to use, and the full schema', () => {
        const text = textOfBuild();

        expect(text.slice(0, text.indexOf('```json'))).toBe(
            `# Server interface of ${ACTOR_FULL_NAME}\n` +
                'single-tenant: the first request starts a run in your account, kept for its idle timeout of 300 s.\n' +
                'Operations (3):\n' +
                '- GET /add: Add two numbers (query). Required: firstNumber.\n' +
                '- POST /add: Add two numbers (JSON body). Required: request body.\n' +
                '- GET /empty: Return no content\n' +
                `${HELPER_TOOLS.ACTOR_SERVER_REQUEST} sends a request to one of them: {"actor":"${ACTOR_FULL_NAME}","method":"GET","path":"/add"}\n` +
                `${DETAILS}{"serverInterface":"GET /add"}} returns one operation excerpt.\n` +
                `References are not expanded or fetched. ${DETAILS}{"serverInterface":"#/components/schemas/Name"}} returns the raw node at a local JSON pointer. The schema's servers are not used.\n` +
                'Full API schema:\n',
        );
        expect(parseJsonBlock(text)).toEqual(SCHEMA);
    });

    const chain: Record<string, unknown> = { P100: required('deep') };
    for (let i = 0; i < 100; i++) chain[`P${i}`] = { $ref: `#/components/parameters/P${i + 1}` };
    // Each row: the `get` operation and `components.parameters` under a path-level `Alias` parameter.
    it.each([
        [
            'keeps one period after a summary that ends with one',
            { summary: 'Hi.', parameters: [required('q')] },
            {},
            ': Hi. Required: q.',
        ],
        [
            'reads required inputs through an alias chain and escaped pointer segments',
            {},
            { Alias: { $ref: '#/components/parameters/Search~1query~0' }, 'Search/query~': required('q') },
            ' Required: q.',
        ],
        [
            'replaces an aliased path-level parameter by its operation-level override',
            { summary: 'Search', parameters: [{ name: 'q', in: 'query' }] },
            { Alias: { $ref: '#/components/parameters/Search' }, Search: required('q') },
            ': Search\n',
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
            ' Required: q.\n',
        ],
    ])('%s', (_label, get, parameters, line) => {
        const schema = {
            paths: { '/search': { parameters: [{ $ref: '#/components/parameters/Alias' }], get } },
            components: { parameters },
        };

        expect(textOfBuild({ schema })).toContain(`- GET /search${line}`);
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
        expect(text.slice(0, text.indexOf('```json'))).not.toContain('example-server-actor');
    });

    it('explains the cost of a multi-tenant Actor', () => {
        const actor = serverActor({ actorStandby: { isEnabled: true, tenancy: 'MULTI_TENANT', idleTimeoutSecs: 300 } });

        expect(textOfBuild({ actor })).toContain(
            'multi-tenant: requests are charged per event and start no run in your account.',
        );
    });
});

describe('one operation', () => {
    it('returns the selected operation, of any method case, with raw references and navigation', () => {
        const text = textOfBuild({ serverInterface: 'get /add' });

        expect(text).toContain(`# Server interface of ${ACTOR_FULL_NAME}: GET /add\nAdd two numbers (query)`);
        expect(text).toContain(
            `${HELPER_TOOLS.ACTOR_SERVER_REQUEST} sends this request: ` +
                `{"actor":"${ACTOR_FULL_NAME}","method":"GET","path":"/add"}`,
        );
        expect(text).toContain('Components are omitted');
        expect(text).toContain('"serverInterface":"#/components/schemas/Name"');
        expect(parseJsonBlock(text)).toEqual({
            openapi: '3.0.0',
            operation: (SCHEMA.paths as Record<string, Record<string, unknown>>)['/add'].get,
        });
    });

    it('keeps an operation navigable when unrelated schema detail is too large', () => {
        const schema = { ...SCHEMA, description: 'a'.repeat(MAX_INLINE_BYTES) };

        const text = textOfBuild({ schema, serverInterface: 'POST /add' });

        expect(parseJsonBlock(text).operation.requestBody.content['application/json'].schema).toEqual({
            $ref: '#/components/schemas/AddRequest',
        });
        expect(text).not.toContain('a'.repeat(100));
    });

    it('preserves inherited parameters and security context in an operation excerpt', () => {
        const schema = {
            openapi: '3.1.0',
            jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
            security: [{ ActorKey: [] }],
            paths: { '/search': { parameters: [required('q')], get: {} } },
        };

        expect(parseJsonBlock(textOfBuild({ schema, serverInterface: 'GET /search' }))).toEqual({
            ...schema,
            paths: undefined,
            operation: { parameters: [required('q')] },
        });
    });
});

describe('the full schema', () => {
    it('leaves reference siblings, examples, and extensions unchanged', () => {
        const schema = {
            ...SCHEMA,
            components: {
                schemas: {
                    Text: { $ref: '#/components/schemas/Node', maxLength: 10, examples: ['Apify'], 'x-name': 'Text' },
                    Node: { $ref: '#/components/schemas/Node' },
                    External: { $ref: 'https://example.com/schema.json' },
                },
            },
        };
        const original = structuredClone(schema);

        expect(parseJsonBlock(textOfBuild({ schema }))).toEqual(original);
        expect(schema).toEqual(original);
    });

    // At the limit the full schema fits; one byte over, guidance included, it is left out.
    it.each([0, 1])('counts the whole text against the byte limit, %i byte over', (over) => {
        const schema = { ...SCHEMA, description: '' };
        schema.description = 'a'.repeat(MAX_INLINE_BYTES - Buffer.byteLength(textOfBuild({ schema })) + over);

        const text = textOfBuild({ schema });

        expect(text.includes(JSON.stringify(schema))).toBe(over === 0);
        expect(text.includes(`Full API schema omitted: exceeds the ${MAX_INLINE_BYTES}-byte limit`)).toBe(over === 1);
    });

    it('falls back to operation navigation when the full schema exceeds the UTF-8 byte cap', () => {
        const text = textOfBuild({ schema: { ...SCHEMA, description: '漢'.repeat(Math.ceil(MAX_INLINE_BYTES / 3)) } });

        expect(text).toContain('Full API schema omitted');
        expect(text).toContain('- POST /add');
        expect(text).not.toContain('```json');
        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_INLINE_BYTES);
    });

    it.each([
        [
            '#/components/schemas/AddRequest',
            (SCHEMA.components as Record<string, Record<string, unknown>>).schemas.AddRequest,
        ],
        ['#/components/schemas/Forbidden~1~0', false],
    ])('returns the raw node at %j', (serverInterface, node) => {
        expect(parseJsonBlock(textOfBuild({ serverInterface }))).toEqual(node);
    });
});

describe('a selection that cannot be returned', () => {
    // `constructor` is inherited by every object; only the schema's own keys are nodes.
    it.each([
        ['GET /nope', 'has no operation "GET /nope". Documented operations: GET /add, POST /add, GET /empty.'],
        ['add', 'has no operation "add". Documented operations: GET /add, POST /add, GET /empty.'],
        ['#/components/schemas/Missing', 'has no schema node at "#/components/schemas/Missing".'],
        ['#/components/schemas/constructor', 'has no schema node at "#/components/schemas/constructor".'],
    ])('is an error for %j', (serverInterface, error) => {
        expect(build({ serverInterface })).toEqual({ error: `Actor '${ACTOR_FULL_NAME}' ${error}` });
    });

    it.each([true, 'GET /search', '#/components/schemas/Huge'])(
        'is a size error, no partial JSON, for %j',
        (serverInterface) => {
            const huge = 'a'.repeat(MAX_INLINE_BYTES);
            const schema = {
                paths: { '/search': { get: { summary: huge } } },
                components: { schemas: { Huge: { huge } } },
            };

            expect(build({ schema, serverInterface })).toEqual({
                error: `Actor '${ACTOR_FULL_NAME}' server-interface output exceeds the ${MAX_INLINE_BYTES}-byte limit and was not returned. A smaller operation or schema node may fit.`,
            });
        },
    );
});

describe('fetching details of a Server Actor', () => {
    const call = async (output?: Record<string, unknown>) => {
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
            loadedToolNames: [HELPER_TOOLS.ACTOR_CALL],
        });
        context.apifyToken = '';
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

    it('returns the selection error for an unknown operation', async () => {
        const result = await call({ serverInterface: 'GET /nope' });

        expect(result.isError).toBe(true);
        expect(textOf(result.content![0])).toContain('Documented operations: GET /add, POST /add, GET /empty.');
    });
});
