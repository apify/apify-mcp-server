import { describe, expect, it } from 'vitest';

import { HELPER_TOOLS, RAG_WEB_BROWSER, WEB_FETCH } from '../../src/const.js';
import { ACTOR_LOAD_ERROR_KIND } from '../../src/errors.js';
import { actorNameToToolName } from '../../src/tools/actor_tool_naming.js';
import { getActorsAsTools } from '../../src/tools/actors/actor_tools_factory.js';
import { buildServerActorToolSchemas } from '../../src/tools/actors/send_server_actor_request.js';
import {
    buildServerActorToolDescription,
    buildServerActorToolInfo,
    CLIENT_DESCRIPTION_MAX_LENGTH,
} from '../../src/tools/actors/server_interface_schema.js';
import { serverActorRequestOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { Actor, ServerActorToolInfo, ToolEntry } from '../../src/types.js';
import { TOOL_TYPE } from '../../src/types.js';
import { mockActor, mockActorBuildClient, mockDefaultBuild } from './helpers/actor_build_client.js';
import { makePaymentProvider } from './helpers/mcp_server.js';
import { only, stubToolCallContext, textOf, type TextToolResult } from './helpers/tool_context.js';

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

/** SCHEMA with a description on GET /empty long enough that the operations in full exceed the description limit. */
const LONG_SCHEMA = {
    ...SCHEMA,
    paths: {
        ...SCHEMA.paths,
        '/empty': { get: { summary: 'Return no content', description: 'a'.repeat(CLIENT_DESCRIPTION_MAX_LENGTH) } },
    },
};

/** Shaped like apify/web-fetch: `GET /` with query parameters, among them `unwrap`, and `POST /` with a JSON body. */
const WEB_FETCH_SCHEMA = {
    paths: {
        '/': {
            get: {
                summary: 'Fetch a URL',
                parameters: [
                    { name: 'url', in: 'query', required: true, schema: { type: 'string' } },
                    { name: 'formats', in: 'query', schema: { type: 'array', items: { type: 'string' } } },
                    { name: 'unwrap', in: 'query', schema: { type: 'boolean' } },
                ],
            },
            post: {
                summary: 'Fetch a URL',
                requestBody: {
                    required: true,
                    content: {
                        'application/json': { schema: { type: 'object', properties: { url: { type: 'string' } } } },
                    },
                },
            },
        },
    },
};

/** apify/web-fetch's API schema as served on 2026-10-28: the request side the tool renders, texts as written. */
const WEB_FETCH_LIVE_SCHEMA = {
    openapi: '3.0.0',
    paths: {
        '/': {
            get: {
                summary: 'Fetch a URL',
                description:
                    'Fetches the resource at the URL and returns its content converted to requested formats plus ' +
                    'metadata. Choose `POST` instead of query params to send a JSON request body.',
                parameters: [
                    {
                        name: 'url',
                        in: 'query',
                        required: true,
                        description:
                            'The URL to fetch. Only `http://` and `https://` schemes are supported; others are ' +
                            'rejected. Only `url` is required.',
                        schema: { $ref: '#/components/schemas/FetchRequest/properties/url' },
                        example: 'https://apify.com',
                    },
                    {
                        name: 'formats',
                        in: 'query',
                        description:
                            'Select one or more formats: `markdown`, `html`, `text`, `links`, `raw`. If omitted, ' +
                            'defaults to `markdown` for HTML/PDF, `text` for text-based content, or `raw` for ' +
                            'images, archives, and other binary content.',
                        schema: { $ref: '#/components/schemas/FetchRequest/properties/formats' },
                    },
                    {
                        name: 'unwrap',
                        in: 'query',
                        description: 'See the unwrap property.',
                        schema: { $ref: '#/components/schemas/FetchRequest/properties/unwrap' },
                    },
                    {
                        name: 'headers',
                        in: 'query',
                        description:
                            'Extra HTTP headers to send with the request, as a JSON string. For example: ' +
                            '`{"Accept-Language":"fr-FR"}`.',
                        schema: { type: 'string' },
                    },
                    {
                        name: 'wait',
                        in: 'query',
                        description:
                            'Milliseconds to wait after the page loads, for content that shows up late. From 1 to ' +
                            '60000. Setting it renders the page in a real browser, so content loaded by JavaScript ' +
                            'is included. Rendered requests are slower.',
                        schema: { $ref: '#/components/schemas/FetchRequest/properties/wait' },
                    },
                ],
            },
            post: {
                summary: 'Fetch a URL',
                requestBody: {
                    required: true,
                    content: { 'application/json': { schema: { $ref: '#/components/schemas/FetchRequest' } } },
                },
            },
        },
    },
    components: {
        schemas: {
            FetchRequest: {
                type: 'object',
                required: ['url'],
                properties: {
                    url: {
                        type: 'string',
                        format: 'uri-reference',
                        description:
                            'The URL to fetch. Only `http://` and `https://` schemes are supported; others are rejected.',
                        example: 'https://apify.com',
                    },
                    formats: {
                        type: 'array',
                        description:
                            "The Actor converts the fetched content to the requested format(s). A format that doesn't " +
                            'apply to the content type returns `null`; if none of the requested formats apply, the ' +
                            'request fails with `UNSUPPORTED_CONTENT_TYPE`. If omitted, defaults to `markdown` for ' +
                            'HTML/PDF, `text` for text-based content, or `raw` for images, archives, and other binary ' +
                            'content. Composes freely with `unwrap`.',
                        items: { type: 'string', enum: ['markdown', 'html', 'text', 'links', 'raw'] },
                    },
                    unwrap: { type: 'boolean', description: 'Returns the first producible format as the body.' },
                    headers: { type: 'object', additionalProperties: { type: 'string' } },
                    wait: {
                        type: 'integer',
                        minimum: 1,
                        maximum: 60000,
                        description:
                            'Milliseconds to wait after the page loads, for content that shows up late. From 1 to ' +
                            '60000. Setting it renders the page in a real browser, so content loaded by JavaScript ' +
                            'is included. Rendered requests are slower.',
                    },
                },
            },
        },
    },
};

let actorCount = 0;

/** Loads a standby Actor serving `schema` as Actor tools; each call is a new Actor, so the definition cache misses. */
async function loadTools(
    schema: unknown,
    options: {
        actor?: Partial<Actor>;
        webServerMcpPath?: string;
        isDirectTool?: boolean;
        hasPaymentProvider?: boolean;
    } = {},
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
        defaultBuild: mockDefaultBuild({ webServerMcpPath: options.webServerMcpPath, webServerSchema: schema }),
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

    it('takes the slot of an Actor that also has an MCP server', async () => {
        const { tools } = await loadTools(SCHEMA, { webServerMcpPath: '/mcp' });

        expect(tools.map((tool) => tool.type)).toEqual([TOOL_TYPE.ACTOR_SERVER]);
    });

    it('leaves an Actor served through its input interface a run tool', async () => {
        const [username, name] = RAG_WEB_BROWSER.split('/');
        const { tools } = await loadTools(SCHEMA, { actor: { username, name } });

        expect(tools.map((tool) => tool.type)).toEqual([TOOL_TYPE.ACTOR]);
    });

    it('is not served in a payment-provider session', async () => {
        const { tools, errors } = await loadTools(SCHEMA, { hasPaymentProvider: true });

        expect(tools).toEqual([]);
        expect(errors.map((error) => error.kind)).toEqual([ACTOR_LOAD_ERROR_KIND.STANDBY_PAYMENT_NOT_SUPPORTED]);
    });
});

describe('the input schema of a Server Actor tool', () => {
    const schemasOf = (info: Partial<ServerActorToolInfo>) =>
        buildServerActorToolSchemas({ methods: ['GET'], paths: ['/'], hasRequestBody: false, ...info });

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

    it('rejects a method or a path outside the documented ones', () => {
        const { ajvValidate } = schemasOf({ methods: ['GET', 'POST'], paths: ['/add', '/empty'] });

        expect(ajvValidate({ method: 'DELETE', path: '/add' })).toBe(false);
        expect(ajvValidate({ method: 'GET', path: '/admin' })).toBe(false);
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

describe('the length of a Server Actor tool description', () => {
    const HEAD = 'Operations:\n';
    const HINT = 'fetch-actor-details returns one operation in full.';
    const LINES = ['- GET /a: A.', '- GET /b: B.', '- GET /c: C.'];
    const infoWith = (fullLength: number, overrides: Partial<ServerActorToolInfo> = {}): ServerActorToolInfo => ({
        methods: ['GET'],
        paths: ['/a', '/b', '/c'],
        hasRequestBody: false,
        fullOperations: 'f'.repeat(fullLength),
        operationLines: LINES,
        operationCount: LINES.length,
        detailsHint: HINT,
        ...overrides,
    });

    it('carries every operation in full when the whole description is at the limit', () => {
        const info = infoWith(CLIENT_DESCRIPTION_MAX_LENGTH - HEAD.length);

        expect(buildServerActorToolDescription(HEAD, info, HINT)).toBe(`${HEAD}${info.fullOperations}`);
    });

    it('lists one line per operation, then the hint, when the full description would be one character over', () => {
        const info = infoWith(CLIENT_DESCRIPTION_MAX_LENGTH - HEAD.length + 1);

        expect(buildServerActorToolDescription(HEAD, info, HINT)).toBe(`${HEAD}${LINES.join('\n')}\n${HINT}`);
    });

    it('cuts the lines at the limit and counts the operations left out', () => {
        const kept = `${LINES[0]}\n… and 2 more`;
        // Room for exactly one line, its newline and the cut line.
        const head = 'h'.repeat(CLIENT_DESCRIPTION_MAX_LENGTH - kept.length - `\n${HINT}`.length);

        const description = buildServerActorToolDescription(head, infoWith(CLIENT_DESCRIPTION_MAX_LENGTH), HINT);

        expect(description).toBe(`${head}${kept}\n${HINT}`);
        expect(description.length).toBe(CLIENT_DESCRIPTION_MAX_LENGTH);
    });

    it('leaves out a line that is one character over the limit, its newline included', () => {
        const head = 'h'.repeat(CLIENT_DESCRIPTION_MAX_LENGTH - `${LINES[0]}\n… and 2 more\n${HINT}`.length + 1);

        const description = buildServerActorToolDescription(head, infoWith(CLIENT_DESCRIPTION_MAX_LENGTH), HINT);

        expect(description).toBe(`${head}… and 3 more\n${HINT}`);
    });

    it('keeps the count of all operations when the fixed text alone exceeds the limit', () => {
        const head = 'h'.repeat(CLIENT_DESCRIPTION_MAX_LENGTH);

        expect(buildServerActorToolDescription(head, infoWith(1), undefined)).toBe(`${head}… and 3 more`);
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

    it('keep only what can fit the description limit', () => {
        const count = 1000;
        const paths = Object.fromEntries(Array.from({ length: count }, (_, i) => [`/path-${i}`, { get: {} }]));

        const info = infoOf({ paths });

        expect(info.fullOperations).toBeUndefined();
        expect(info.operationCount).toBe(count);
        expect(info.operationLines.join('\n').length).toBeLessThanOrEqual(CLIENT_DESCRIPTION_MAX_LENGTH);
        expect(info.operationLines.length).toBeLessThan(count);
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

describe('the default apify/web-fetch tool', () => {
    const [username, name] = WEB_FETCH.split('/');
    const loadWebFetchTool = async () =>
        loadServerTool(WEB_FETCH_SCHEMA, {
            username,
            name,
            actorStandby: { isEnabled: true, tenancy: 'MULTI_TENANT' },
        });

    it('takes only GET / with no body, both defaulted', async () => {
        const tool = await loadWebFetchTool();
        const args: Record<string, unknown> = { query: { url: 'https://example.com' } };

        expect(tool.inputSchema.properties).toMatchObject({ method: { enum: ['GET'] }, path: { enum: ['/'] } });
        expect(tool.inputSchema.properties).not.toHaveProperty('body');
        expect(tool.ajvValidate(args)).toBe(true);
        expect(args).toMatchObject({ method: 'GET', path: '/' });
    });

    it('describes only GET /, without unwrap', async () => {
        const tool = await loadWebFetchTool();

        expect(tool.description).toContain('{"operations":[{"method":"GET","path":"/"');
        expect(tool.description).toContain('"name":"formats"');
        expect(tool.description).not.toContain('"method":"POST"');
        expect(tool.description).not.toContain('unwrap');
    });

    it('describes the query encodings and the URL scheme limit', async () => {
        const tool = await loadWebFetchTool();

        expect(tool.description).toContain('formats is a comma-separated string, such as "markdown,links"');
        expect(tool.description).toContain('headers is a JSON object as a string, such as {"Accept-Language":"fr-FR"}');
        expect(tool.description).toContain('a non-http(s) scheme such as ftp:');
    });

    it('rejects unwrap before sending the request', async () => {
        const tool = await loadWebFetchTool();
        if (tool.type !== TOOL_TYPE.ACTOR_SERVER) throw new Error('Expected a server tool');
        const { apifyClient } = mockActorBuildClient({ actor: mockActor(), defaultBuild: mockDefaultBuild() });

        const result = (await tool.call(
            stubToolCallContext(
                { method: 'GET', path: '/', query: { url: 'https://example.com', unwrap: true } },
                apifyClient,
            ),
        )) as TextToolResult;

        expect(result.isError).toBe(true);
        expect(textOf(result.content[0])).toContain('"unwrap" is not accepted by this tool');
    });

    it('carries GET / in full within the client description limit, with the live schema and Actor description', async () => {
        const tool = await loadServerTool(WEB_FETCH_LIVE_SCHEMA, {
            username,
            name,
            description:
                'Download any web page by URL and convert it to clean Markdown, plain text, HTML, and other formats. ' +
                'Automatically renders JavaScript and works around bot blocking. The Actor provides a real-time API ' +
                'for quick response times.',
            actorStandby: { isEnabled: true, tenancy: 'MULTI_TENANT' },
        });

        expect(tool.description).toContain('Operations:\n```json\n{"operations":[{"method":"GET","path":"/"');
        expect(tool.description).toContain('"name":"wait"');
        expect(tool.description.length).toBeLessThanOrEqual(CLIENT_DESCRIPTION_MAX_LENGTH);
    });

    it('keeps the read-only hint of the Actor', async () => {
        const tool = await loadWebFetchTool();

        expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    });
});
