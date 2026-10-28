import { describe, expect, it } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { ACTOR_LOAD_ERROR_KIND } from '../../src/errors.js';
import { actorNameToToolName } from '../../src/tools/actor_tool_naming.js';
import { getActorsAsTools } from '../../src/tools/actors/actor_tools_factory.js';
import { buildServerActorToolSchemas } from '../../src/tools/actors/send_server_actor_request.js';
import {
    buildServerActorToolInfo,
    SERVER_TOOL_OPERATIONS_MAX_BYTES,
} from '../../src/tools/actors/server_interface_schema.js';
import { serverActorRequestOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { Actor, ServerActorToolInfo, ToolEntry } from '../../src/types.js';
import { TOOL_TYPE } from '../../src/types.js';
import { mockActor, mockActorBuildClient, mockDefaultBuild } from './helpers/actor_build_client.js';
import { makePaymentProvider } from './helpers/mcp_server.js';
import { only } from './helpers/tool_context.js';

/** Shaped like apify/server-actor-test: query parameters, a JSON body behind a reference, and a templated path. */
const SCHEMA = {
    paths: {
        '/add': {
            get: {
                summary: 'Add two numbers (query)',
                parameters: [{ name: 'firstNumber', in: 'query', required: true, schema: { type: 'integer' } }],
            },
            post: {
                summary: 'Add two numbers (JSON body)',
                requestBody: {
                    required: true,
                    content: { 'application/json': { schema: { $ref: '#/components/schemas/Add' } } },
                },
            },
        },
        '/empty': { get: { summary: 'Return no content' } },
    },
    components: {
        schemas: {
            Add: { type: 'object', required: ['firstNumber'], properties: { firstNumber: { type: 'integer' } } },
        },
    },
};

/** SCHEMA with a description on GET /empty long enough that the operations in full exceed the description budget. */
const LONG_SCHEMA = {
    ...SCHEMA,
    paths: {
        ...SCHEMA.paths,
        '/empty': { get: { summary: 'Return no content', description: 'a'.repeat(SERVER_TOOL_OPERATIONS_MAX_BYTES) } },
    },
};

let actorCount = 0;

/** Loads a standby Actor serving `schema` as Actor tools; each call is a new Actor, so the definition cache misses. */
async function loadTools(
    schema: unknown,
    options: { actor?: Partial<Actor>; isDirectTool?: boolean; hasPaymentProvider?: boolean } = {},
) {
    actorCount += 1;
    const actor = mockActor({
        id: `server-actor-${actorCount}`,
        name: `server-actor-${actorCount}`,
        description: 'Adds numbers.',
        actorStandby: { isEnabled: true, tenancy: 'SINGLE_TENANT', idleTimeoutSecs: 300 },
        ...options.actor,
    });
    const { apifyClient } = mockActorBuildClient({
        actor,
        defaultBuild: mockDefaultBuild({ webServerMcpPath: undefined, webServerSchema: schema }),
    });
    return getActorsAsTools([`${actor.username}/${actor.name}`], apifyClient, {
        isDirectTool: options.isDirectTool,
        paymentProvider: options.hasPaymentProvider ? makePaymentProvider() : undefined,
    });
}

async function loadServerTool(schema: unknown, actor?: Partial<Actor>): Promise<ToolEntry> {
    const { tools } = await loadTools(schema, { actor });
    expect(tools).toHaveLength(1);
    return tools[0];
}

function infoOf(schema: unknown): ServerActorToolInfo {
    const info = buildServerActorToolInfo(schema, 'apify/server-actor-test');
    if (!info) throw new Error('Expected operations');
    return info;
}

describe('serving a selected Server Actor through its server interface', () => {
    it('serves one tool under the Actor tool name that sends a request instead of starting a run', async () => {
        const tool = await loadServerTool(SCHEMA);

        expect(tool).toMatchObject({
            type: TOOL_TYPE.ACTOR_SERVER,
            name: actorNameToToolName(`acme/server-actor-${actorCount}`),
            outputSchema: serverActorRequestOutputSchema,
        });
        expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual(['method', 'path', 'query', 'body']);
        expect(tool.execution).toBeUndefined();
    });

    it('keeps a run tool for call-actor', async () => {
        const { tools } = await loadTools(SCHEMA, { isDirectTool: false });

        expect(tools.map((tool) => tool.type)).toEqual([TOOL_TYPE.ACTOR]);
    });

    it.each([
        ['an Apify Actor with limited permissions', { username: 'apify' }, true],
        ['another publisher', {}, false],
    ])('keeps the read-only hint of %s', async (_label, actor, isReadOnly) => {
        const tool = await loadServerTool(SCHEMA, actor);

        expect(tool.annotations).toMatchObject({ readOnlyHint: isReadOnly, destructiveHint: !isReadOnly });
    });

    it('is not served in a payment-provider session', async () => {
        const { tools, errors } = await loadTools(SCHEMA, { hasPaymentProvider: true });

        expect(tools).toEqual([]);
        expect(errors.map((error) => error.kind)).toEqual([ACTOR_LOAD_ERROR_KIND.STANDBY_PAYMENT_NOT_SUPPORTED]);
    });
});

describe('the input schema of a Server Actor tool', () => {
    const schemasOf = (info: Partial<ServerActorToolInfo>) =>
        buildServerActorToolSchemas({ methods: ['GET'], paths: ['/'], hasRequestBody: false, operations: '', ...info });

    it('narrows the method and the path to the documented ones and requires them', () => {
        const { inputSchema } = schemasOf({
            methods: ['GET', 'POST'],
            paths: ['/add', '/empty'],
            hasRequestBody: true,
        });

        expect(inputSchema.properties).toMatchObject({
            method: { enum: ['GET', 'POST'] },
            path: { enum: ['/add', '/empty'] },
        });
        expect(inputSchema.required).toEqual(['method', 'path']);
    });

    it('defaults a single method and path, which the validator fills in', () => {
        const { inputSchema, ajvValidate } = schemasOf({ methods: ['POST'], paths: ['/'] });
        const args: Record<string, unknown> = {};

        expect(inputSchema.properties).toMatchObject({ method: { default: 'POST' }, path: { default: '/' } });
        expect(ajvValidate(args)).toBe(true);
        expect(args).toEqual({ method: 'POST', path: '/' });
    });

    it('takes a templated path as a string that lists the paths, with no default', () => {
        const { inputSchema, ajvValidate } = schemasOf({ paths: ['/status/{code}'] });
        const path = inputSchema.properties?.path as Record<string, unknown>;

        expect(path).not.toHaveProperty('enum');
        expect(path).not.toHaveProperty('default');
        expect(path.description).toContain('/status/{code}');
        expect(ajvValidate({ path: '/status/404' })).toBe(true);
    });

    it('leaves the body out when no operation takes one', () => {
        expect(schemasOf({ hasRequestBody: false }).inputSchema.properties).not.toHaveProperty('body');
    });
});

describe('the operations in a Server Actor tool description', () => {
    it('are the operations in full when they fit, with no lookup to point at', async () => {
        const tool = await loadServerTool(SCHEMA);

        expect(tool.description).toContain(
            'single-tenant: the first request starts a run in your account, kept for its idle timeout of 300 s.',
        );
        expect(tool.description).toContain('Operations:\n```json\n{"operations":[{"method":"GET","path":"/add"');
        expect(tool.description).not.toContain(HELPER_TOOLS.ACTOR_GET_DETAILS);
    });

    it('are one line per operation over the budget, pointing at fetch-actor-details only when the session has it', async () => {
        const tool = await loadServerTool(LONG_SCHEMA);
        const lines =
            'Operations:\n' +
            '- GET /add [firstNumber:integer required]: Add two numbers (query).\n' +
            '- POST /add {firstNumber:integer required}: Add two numbers (JSON body).\n' +
            '- GET /empty: Return no content.';

        expect(tool.buildDescription?.(only(HELPER_TOOLS.ACTOR_GET_DETAILS))).toContain(
            `${lines}\n${HELPER_TOOLS.ACTOR_GET_DETAILS} with {"actor":"acme/server-actor-${actorCount}","output":{"serverInterface":"GET /add"}} returns one operation in full.`,
        );
        expect(tool.buildDescription?.(only()).endsWith(lines)).toBe(true);
    });

    it('cut the lines at the budget and count the operations left out', () => {
        const count = 1000;
        const paths = Object.fromEntries(Array.from({ length: count }, (_, i) => [`/path-${i}`, { get: {} }]));

        const { operations } = infoOf({ paths });

        const lines = operations.split('\n').filter((line) => line.startsWith('- GET /'));
        expect(operations.endsWith(`\n… and ${count - lines.length} more`)).toBe(true);
        expect(Buffer.byteLength(operations)).toBeLessThanOrEqual(SERVER_TOOL_OPERATIONS_MAX_BYTES);
    });

    it('come with the documented methods and paths, and whether an operation takes a body', () => {
        expect(infoOf(SCHEMA)).toMatchObject({
            methods: ['GET', 'POST'],
            paths: ['/add', '/empty'],
            hasRequestBody: true,
        });
        expect(buildServerActorToolInfo({ paths: {} }, 'apify/server-actor-test')).toBeUndefined();
    });
});
