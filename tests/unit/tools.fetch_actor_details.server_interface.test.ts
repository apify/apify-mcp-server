import { describe, expect, it } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { buildFetchActorDetailsResult } from '../../src/tools/actors/fetch_actor_details.js';
import {
    buildServerInterfaceSection,
    buildServerInterfaceSummary,
} from '../../src/tools/actors/server_interface_schema.js';
import type { Actor } from '../../src/types.js';
import { mockActor, mockActorBuildClient, mockDefaultBuild } from './helpers/actor_build_client.js';
import { mockApifyClient, stubToolCallContext, textOf } from './helpers/tool_context.js';

const ACTOR_FULL_NAME = 'apify/server-actor-test';
const STANDBY_URL = 'https://server-actor-test.apify.actor';

/** The fixture's schema shapes: parameter, request body and response references, like apify/web-fetch's `FetchRequest`. */
const SCHEMA: Record<string, unknown> = {
    openapi: '3.0.0',
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
        },
        '/empty': { get: { summary: 'Return no content', responses: { '204': { description: 'No content.' } } } },
    },
    components: {
        schemas: {
            AddRequest: { type: 'object', properties: { firstNumber: { type: 'integer' } }, required: ['firstNumber'] },
            AddResponse: { type: 'object', properties: { sum: { type: 'integer' } } },
        },
        parameters: { AsText: { name: 'asText', in: 'query', required: false, schema: { type: 'boolean' } } },
        responses: {
            Add: {
                description: 'The sum.',
                content: { 'application/json': { schema: { $ref: '#/components/schemas/AddResponse' } } },
            },
        },
    },
};

function serverActor(overrides: Partial<Actor> = {}): Pick<Actor, 'actorStandby' | 'standbyUrl'> {
    return {
        actorStandby: { isEnabled: true, tenancy: 'SINGLE_TENANT', idleTimeoutSecs: 300 },
        standbyUrl: STANDBY_URL,
        ...overrides,
    };
}

function section(params: Partial<Parameters<typeof buildServerInterfaceSection>[0]> = {}) {
    return buildServerInterfaceSection({
        actor: serverActor(),
        actorFullName: ACTOR_FULL_NAME,
        schema: SCHEMA,
        serverInterface: true,
        loadedToolNames: Object.values(HELPER_TOOLS),
        hasPaymentProvider: false,
        ...params,
    });
}

function textOfSection(params: Partial<Parameters<typeof buildServerInterfaceSection>[0]> = {}): string {
    const result = section(params);
    if (!result || 'error' in result) throw new Error(`Expected a section, got ${JSON.stringify(result)}`);
    return result.text;
}

function summary(params: Partial<Parameters<typeof buildServerInterfaceSummary>[0]> = {}) {
    return buildServerInterfaceSummary({
        actor: serverActor(),
        actorFullName: ACTOR_FULL_NAME,
        schema: SCHEMA,
        ...params,
    });
}

describe('buildServerInterfaceSummary()', () => {
    it('states the tenancy, names each operation and the fetch-actor-details call that lists them', () => {
        expect(summary()).toBe(
            'Server interface: enabled, single-tenant, 3 documented operations: GET /add, POST /add, GET /empty. ' +
                `${HELPER_TOOLS.ACTOR_GET_DETAILS} with {"actor":"${ACTOR_FULL_NAME}","output":{"serverInterface":true}} lists them.`,
        );
    });

    it('states only the operation count over five operations', () => {
        const paths = Object.fromEntries(['/a', '/b', '/c', '/d', '/e', '/f'].map((path) => [path, { get: {} }]));

        expect(summary({ schema: { paths } })).toBe(
            'Server interface: enabled, single-tenant, 6 documented operations. ' +
                `${HELPER_TOOLS.ACTOR_GET_DETAILS} with {"actor":"${ACTOR_FULL_NAME}","output":{"serverInterface":true}} lists them.`,
        );
    });

    it.each([undefined, { paths: {} }])('says the interface is undocumented when the schema is %s', (schema) => {
        expect(summary({ schema })).toBe(
            'Server interface: enabled, single-tenant, undocumented: no API schema. See the README.',
        );
    });

    it('is absent for an Actor without a server interface', () => {
        expect(summary({ actor: { actorStandby: { isEnabled: false } } })).toBe(undefined);
    });
});

describe('buildServerInterfaceSection()', () => {
    describe('the operation list', () => {
        it('says the interface is undocumented for a Server Actor without an API schema', () => {
            expect(textOfSection({ schema: undefined })).toBe(
                'Server interface: enabled, single-tenant, undocumented: no API schema. See the README.',
            );
        });

        it('lists each operation with its summary and required inputs under the Actor name, and a send tool call for the first', () => {
            const text = textOfSection({ serverInterface: true });

            expect(text).toContain(`# Server interface of ${ACTOR_FULL_NAME}\n`);
            expect(text).not.toContain('Base URL');
            expect(text).toContain(
                `${HELPER_TOOLS.ACTOR_SERVER_REQUEST} sends a request to one of them: ` +
                    `{"actor":"${ACTOR_FULL_NAME}","method":"GET","path":"/add"}`,
            );
            expect(text).toContain(
                `${HELPER_TOOLS.ACTOR_GET_DETAILS} with ` +
                    `{"actor":"${ACTOR_FULL_NAME}","output":{"serverInterface":"GET /add"}} returns one operation's`,
            );
            expect(text).toContain('Operations (3):');
            expect(text).toContain('- GET /add: Add two numbers (query). Required: firstNumber.');
            expect(text).toContain('- POST /add: Add two numbers (JSON body). Required: request body.');
            expect(text).toContain('- GET /empty: Return no content\n');
        });

        it('keeps one period after a summary that already ends with one', () => {
            const schema = {
                openapi: '3.0.3',
                paths: {
                    '/': {
                        get: {
                            summary: 'Fetch a URL.',
                            parameters: [{ name: 'url', in: 'query', required: true, schema: { type: 'string' } }],
                        },
                    },
                },
            };

            expect(textOfSection({ schema, serverInterface: true })).toContain('- GET /: Fetch a URL. Required: url.');
        });

        it('lists only the methods the send tool accepts', () => {
            const schema = { openapi: '3.0.3', paths: { '/': { get: { summary: 'Fetch' }, head: {}, options: {} } } };

            const text = textOfSection({ schema, serverInterface: true });

            expect(text).toContain('Operations (1):');
            expect(text).not.toMatch(/- (HEAD|OPTIONS) \//);
        });

        it('says requests are not supported, without the send tool or run cost, in a payment-provider session', () => {
            const text = textOfSection({ serverInterface: true, hasPaymentProvider: true });

            expect(text).toContain('not supported in agentic payment mode');
            expect(text).not.toContain(HELPER_TOOLS.ACTOR_SERVER_REQUEST);
            expect(text).not.toContain('starts a run');
        });

        it('lists required path-level inputs through a parameter alias chain', () => {
            const schema = {
                openapi: '3.0.3',
                paths: { '/search': { parameters: [{ $ref: '#/components/parameters/Alias' }], get: {} } },
                components: {
                    parameters: {
                        Alias: { $ref: '#/components/parameters/Search' },
                        Search: { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
                    },
                },
            };

            expect(textOfSection({ schema, serverInterface: true })).toContain('- GET /search Required: q.');
        });

        it('replaces an aliased path-level parameter by its operation-level override', () => {
            const schema = {
                openapi: '3.0.3',
                paths: {
                    '/search': {
                        parameters: [{ $ref: '#/components/parameters/Alias' }],
                        get: {
                            summary: 'Search',
                            parameters: [{ name: 'q', in: 'query', schema: { type: 'integer' } }],
                        },
                    },
                },
                components: {
                    parameters: {
                        Alias: { $ref: '#/components/parameters/Search' },
                        Search: { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
                    },
                },
            };

            expect(textOfSection({ schema, serverInterface: true })).toContain('- GET /search: Search\n');
            const text = textOfSection({ schema, serverInterface: 'GET /search' });
            const detail = JSON.parse(text.slice(text.indexOf('```json\n') + 8, text.lastIndexOf('\n```')));
            expect(detail.parameters).toEqual([{ name: 'q', in: 'query', schema: { type: 'integer' } }]);
        });

        it("gives the Actor's standby URL as the base URL instead of the send tool when the session lacks it", () => {
            const text = textOfSection({ serverInterface: true, loadedToolNames: [HELPER_TOOLS.ACTOR_GET_DETAILS] });

            expect(text).not.toContain(HELPER_TOOLS.ACTOR_SERVER_REQUEST);
            expect(text).toContain(`Base URL: ${STANDBY_URL}`);
            expect(text).not.toContain('example-server-actor');
        });

        it.each([
            [
                'SINGLE_TENANT',
                'single-tenant: the first request starts a run in your account, kept for its idle timeout of 300 s.',
            ],
            ['MULTI_TENANT', 'multi-tenant: requests are charged per event and start no run in your account.'],
        ] as const)('explains the cost of a %s Actor', (tenancy, sentence) => {
            const text = textOfSection({
                serverInterface: true,
                actor: serverActor({ actorStandby: { isEnabled: true, tenancy, idleTimeoutSecs: 300 } }),
            });

            expect(text).toContain(sentence);
        });

        it('says there is no server interface when an Actor without one is asked for it', () => {
            expect(textOfSection({ serverInterface: true, actor: { actorStandby: { isEnabled: false } } })).toBe(
                `Actor '${ACTOR_FULL_NAME}' has no server interface.`,
            );
        });
    });

    describe('one operation', () => {
        it('renders the parameters with a parameter reference and the responses with a response reference resolved', () => {
            const text = textOfSection({ serverInterface: 'GET /add' });

            expect(text).toContain(`# Server interface of ${ACTOR_FULL_NAME}: GET /add\nAdd two numbers (query)`);
            expect(text).toContain(
                `${HELPER_TOOLS.ACTOR_SERVER_REQUEST} sends this request: ` +
                    `{"actor":"${ACTOR_FULL_NAME}","method":"GET","path":"/add"}`,
            );
            const detail = JSON.parse(text.slice(text.indexOf('```json\n') + 8, text.lastIndexOf('\n```'))) as {
                parameters: { name: string }[];
                responses: Record<string, { content: Record<string, { schema: unknown }> }>;
            };
            expect(detail.parameters.map((parameter) => parameter.name)).toEqual(['firstNumber', 'asText']);
            expect(detail.responses['200'].content['application/json'].schema).toEqual({
                type: 'object',
                properties: { sum: { type: 'integer' } },
            });
            expect(text).not.toContain('$ref');
        });

        it('renders the request body with its schema reference resolved, accepting a lower-case method', () => {
            const text = textOfSection({ serverInterface: 'post /add' });

            expect(text).toContain(`# Server interface of ${ACTOR_FULL_NAME}: POST /add`);
            expect(text).toContain('"required":["firstNumber"]');
            expect(text).not.toContain('/empty');
        });

        it('renders OpenAPI 3.1 schema constraints next to a resolved request-body reference', () => {
            const schema = {
                openapi: '3.1.0',
                paths: {
                    '/search': {
                        post: {
                            requestBody: {
                                content: {
                                    'application/json': {
                                        schema: { $ref: '#/components/schemas/Text', maxLength: 10 },
                                    },
                                },
                            },
                            responses: { '200': { description: 'OK' } },
                        },
                    },
                },
                components: { schemas: { Text: { type: 'string' } } },
            };

            const text = textOfSection({ schema, serverInterface: 'POST /search' });
            const detail = JSON.parse(text.slice(text.indexOf('```json\n') + 8, text.lastIndexOf('\n```')));
            expect(detail.requestBody.content['application/json'].schema).toEqual({
                maxLength: 10,
                allOf: [{ type: 'string' }],
            });
        });

        it.each(['GET /nope', 'add'])('returns a selection error listing the operations for %j', (serverInterface) => {
            expect(section({ serverInterface })).toEqual({
                error:
                    `Actor '${ACTOR_FULL_NAME}' has no operation "${serverInterface}". ` +
                    'Documented operations: GET /add, POST /add, GET /empty.',
            });
        });
    });
});

describe('buildFetchActorDetailsResult() with a Server Actor', () => {
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

    it('carries the summary line in the text and structuredContent of the default output', async () => {
        const result = await call();

        const texts = (result.content ?? []).map(textOf);
        expect(texts.at(-1)).toContain(
            'Server interface: enabled, single-tenant, 3 documented operations: GET /add, POST /add, GET /empty.',
        );
        expect((result.structuredContent as { serverInterface?: string }).serverInterface).toBe(texts.at(-1));
    });

    it('carries the summary line in a selective output that does not ask for the server interface', async () => {
        const result = await call({ inputSchema: true });

        const texts = (result.content ?? []).map(textOf);
        expect(texts.at(-1)).toContain(
            'Server interface: enabled, single-tenant, 3 documented operations: GET /add, POST /add, GET /empty.',
        );
        expect((result.structuredContent as { serverInterface?: string }).serverInterface).toBe(texts.at(-1));
    });

    it('returns the selection error for an unknown operation', async () => {
        const result = await call({ serverInterface: 'GET /nope' });

        expect(result.isError).toBe(true);
        expect(textOf(result.content![0])).toContain('Documented operations: GET /add, POST /add, GET /empty.');
    });
});
