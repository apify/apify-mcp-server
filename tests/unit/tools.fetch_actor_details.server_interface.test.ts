import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { buildFetchActorDetailsResult } from '../../src/tools/actors/fetch_actor_details.js';
import { buildServerInterfaceSection } from '../../src/tools/actors/server_interface_schema.js';
import type { Actor } from '../../src/types.js';
import type { ActorDetailsResult } from '../../src/utils/actor_details.js';
import { fetchActorDetails } from '../../src/utils/actor_details.js';
import { mockApifyClient, stubToolCallContext, textOf } from './helpers/tool_context.js';

vi.mock('../../src/utils/actor_details.js', async () => {
    const actual = await vi.importActual<Record<string, unknown>>('../../src/utils/actor_details.js');
    return { ...actual, fetchActorDetails: vi.fn() };
});

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
        selection: false,
        loadedToolNames: Object.values(HELPER_TOOLS),
        ...params,
    });
}

function textOfSection(params: Partial<Parameters<typeof buildServerInterfaceSection>[0]> = {}): string {
    const result = section(params);
    if (!result || 'error' in result) throw new Error(`Expected a section, got ${JSON.stringify(result)}`);
    return result.text;
}

describe('buildServerInterfaceSection()', () => {
    describe('the one-line summary of the default output', () => {
        it('states the tenancy, the operation count and how to expand it for a Server Actor with an API schema', () => {
            const text = textOfSection();

            expect(text).toBe(
                'Server interface: enabled, single-tenant, 3 documented operations. ' +
                    'output.serverInterface: true lists them, "METHOD /path" details one.',
            );
        });

        it.each([undefined, { paths: {} }])('says the interface is undocumented when the schema is %s', (schema) => {
            expect(textOfSection({ schema })).toBe(
                'Server interface: enabled, single-tenant, undocumented: no API schema. See the README.',
            );
        });

        it('is absent for an Actor without a server interface', () => {
            expect(section({ actor: { actorStandby: { isEnabled: false } } })).toBeUndefined();
        });
    });

    describe('the operation list', () => {
        it("lists each operation with its summary and required inputs, the Actor's standby URL as the base URL, and the send tool", () => {
            const text = textOfSection({ selection: true });

            expect(text).toContain(`Base URL: ${STANDBY_URL}`);
            expect(text).not.toContain('example-server-actor');
            expect(text).toContain(`Requests go through ${HELPER_TOOLS.ACTOR_SERVER_REQUEST}.`);
            expect(text).toContain('Operations (3):');
            expect(text).toContain('- GET /add: Add two numbers (query). Required: firstNumber.');
            expect(text).toContain('- POST /add: Add two numbers (JSON body). Required: request body.');
            expect(text).toContain('- GET /empty: Return no content\n');
        });

        it('names a required path-level parameter among the required inputs of an operation under the path', () => {
            const schema = {
                paths: {
                    '/items/{id}': {
                        parameters: [{ $ref: '#/components/parameters/ItemId' }],
                        get: { summary: 'Get an item' },
                    },
                },
                components: { parameters: { ItemId: { name: 'id', in: 'path', required: true } } },
            };

            expect(textOfSection({ schema, selection: true })).toContain(
                '- GET /items/{id}: Get an item. Required: id.',
            );
        });

        it("replaces a path-level parameter with the operation's parameter of the same name and location", () => {
            const schema = {
                paths: {
                    '/items': {
                        parameters: [{ name: 'verbose', in: 'query', required: true }],
                        get: { summary: 'List items', parameters: [{ name: 'verbose', in: 'query' }] },
                    },
                },
            };

            expect(textOfSection({ schema, selection: true })).toContain('- GET /items: List items\n');
        });

        it('lists required inputs through a parameter alias chain', () => {
            const schema = {
                openapi: '3.0.3',
                paths: { '/search': { get: { parameters: [{ $ref: '#/components/parameters/Alias' }] } } },
                components: {
                    parameters: {
                        Alias: { $ref: '#/components/parameters/Search' },
                        Search: { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
                    },
                },
            };

            expect(textOfSection({ schema, selection: true })).toContain('- GET /search Required: q.');
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

            expect(textOfSection({ schema, selection: true })).toContain('- GET /search: Search\n');
            const text = textOfSection({ schema, selection: 'GET /search' });
            const detail = JSON.parse(text.slice(text.indexOf('```json\n') + 8, text.lastIndexOf('\n```')));
            expect(detail.parameters).toEqual([{ name: 'q', in: 'query', schema: { type: 'integer' } }]);
        });

        it('names the send tool only when the session has it', () => {
            const text = textOfSection({ selection: true, loadedToolNames: [HELPER_TOOLS.ACTOR_GET_DETAILS] });

            expect(text).not.toContain(HELPER_TOOLS.ACTOR_SERVER_REQUEST);
        });

        it.each([
            [
                'SINGLE_TENANT',
                'single-tenant: the first request starts a run in your account, kept for its idle timeout of 300 s.',
            ],
            ['MULTI_TENANT', 'multi-tenant: requests are charged per event and start no run in your account.'],
        ] as const)('explains the cost of a %s Actor', (tenancy, sentence) => {
            const text = textOfSection({
                selection: true,
                actor: serverActor({ actorStandby: { isEnabled: true, tenancy, idleTimeoutSecs: 300 } }),
            });

            expect(text).toContain(sentence);
        });

        it('says there is no server interface when an Actor without one is asked for it', () => {
            expect(textOfSection({ selection: true, actor: { actorStandby: { isEnabled: false } } })).toBe(
                `Actor '${ACTOR_FULL_NAME}' has no server interface.`,
            );
        });
    });

    describe('one operation', () => {
        it('renders the parameters with a parameter reference and the responses with a response reference resolved', () => {
            const text = textOfSection({ selection: 'GET /add' });

            expect(text).toContain('# Server interface: GET /add\nAdd two numbers (query)');
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
            const text = textOfSection({ selection: 'post /add' });

            expect(text).toContain('# Server interface: POST /add');
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

            const text = textOfSection({ schema, selection: 'POST /search' });
            const detail = JSON.parse(text.slice(text.indexOf('```json\n') + 8, text.lastIndexOf('\n```')));
            expect(detail.requestBody.content['application/json'].schema).toEqual({
                maxLength: 10,
                allOf: [{ type: 'string' }],
            });
        });

        it.each(['GET /nope', 'add', 'DELETE /add'])(
            'returns a selection error listing the operations for %j',
            (selection) => {
                expect(section({ selection })).toEqual({
                    error:
                        `Actor '${ACTOR_FULL_NAME}' has no operation "${selection}". ` +
                        'Documented operations: GET /add, POST /add, GET /empty.',
                });
            },
        );
    });
});

describe('buildFetchActorDetailsResult() with a Server Actor', () => {
    const details = {
        actorInfo: {
            id: 'server-actor-id',
            name: 'server-actor-test',
            username: 'apify',
            actorStandby: { isEnabled: true, tenancy: 'SINGLE_TENANT' },
            standbyUrl: STANDBY_URL,
        },
        actorCard: '# Actor card',
        actorCardStructured: { id: 'server-actor-id', fullName: ACTOR_FULL_NAME },
        inputSchema: { type: 'object', properties: {} },
        readme: '# README',
        webServerSchema: SCHEMA,
    } as unknown as ActorDetailsResult;

    beforeEach(() => {
        vi.mocked(fetchActorDetails).mockReset();
        vi.mocked(fetchActorDetails).mockResolvedValue(details);
    });

    const call = async (output?: Record<string, unknown>) =>
        buildFetchActorDetailsResult(
            stubToolCallContext({ actor: ACTOR_FULL_NAME, ...(output && { output }) }, mockApifyClient(), {
                loadedToolNames: [HELPER_TOOLS.ACTOR_CALL],
            }),
        );

    it('carries the summary line in the text and structuredContent of the default output', async () => {
        const result = await call();

        const texts = (result.content ?? []).map(textOf);
        expect(texts.at(-1)).toContain('Server interface: enabled, single-tenant, 3 documented operations.');
        expect((result.structuredContent as { serverInterface?: string }).serverInterface).toBe(texts.at(-1));
    });

    it('leaves the server interface out of a selective output that does not ask for it', async () => {
        const result = await call({ inputSchema: true });

        expect((result.content ?? []).map(textOf).join('\n')).not.toContain('Server interface');
        expect((result.structuredContent as { serverInterface?: string }).serverInterface).toBeUndefined();
    });

    it('returns the selection error for an unknown operation', async () => {
        const result = await call({ serverInterface: 'GET /nope' });

        expect(result.isError).toBe(true);
        expect(textOf(result.content![0])).toContain('Documented operations: GET /add, POST /add, GET /empty.');
    });
});
