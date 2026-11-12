import { describe, expect, it } from 'vitest';

import { defaults, HELPER_TOOLS, RAG_WEB_BROWSER, WEB_FETCH, WEB_SEARCH } from '../../src/const.js';
import { ACTOR_LOAD_ERROR_KIND } from '../../src/errors.js';
import type { InvalidToolCall, PreparedCall } from '../../src/mcp/tool_call_engine.js';
import { prepareToolCall } from '../../src/mcp/tool_call_engine.js';
import { actorDefinitionCache } from '../../src/state.js';
import { actorNameToToolName } from '../../src/tools/actor_tool_naming.js';
import { getActorsAsTools } from '../../src/tools/actors/actor_tools_factory.js';
import { buildServerActorToolSchemas } from '../../src/tools/actors/send_server_actor_request.js';
import {
    buildServerActorToolDescription,
    buildServerActorToolInfo,
    CLIENT_DESCRIPTION_MAX_LENGTH,
} from '../../src/tools/actors/server_interface_details.js';
import { listCommaJoinedQueryParameters } from '../../src/tools/actors/server_interface_schema.js';
import { serverActorRequestOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { Actor, ServerActorToolInfo, ToolEntry } from '../../src/types.js';
import { TOOL_TYPE } from '../../src/types.js';
import { resolveToolNamesFromInput } from '../../src/utils/tools_loader.js';
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

/** SCHEMA with a description on GET /empty long enough that the operations in full exceed the description limit. */
const LONG_SCHEMA = {
    ...SCHEMA,
    paths: {
        ...SCHEMA.paths,
        '/empty': { get: { summary: 'Return no content', description: 'a'.repeat(CLIENT_DESCRIPTION_MAX_LENGTH) } },
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
                        style: 'form',
                        explode: false,
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

/** apify/web-search's API schema as served on 2026-11-04 (build OitYfemqCzJSA6yMQ): the request side the tool renders, texts as written. */
const WEB_SEARCH_LIVE_SCHEMA = {
    openapi: '3.0.0',
    paths: {
        '/': {
            get: {
                summary: 'Run a search',
                description:
                    'Runs one search and returns one page of organic results. Parameters go in the query ' +
                    'string; array fields are comma-separated, e.g. ' +
                    '`allowedDomains=example.com,example.org`. Use `POST` to send them as a JSON object ' +
                    'instead.',
                parameters: [
                    {
                        name: 'query',
                        in: 'query',
                        required: true,
                        example: 'latest AI agent payment protocols',
                        schema: {
                            $ref: '#/components/schemas/SearchRequest/properties/query',
                        },
                    },
                    {
                        name: 'provider',
                        in: 'query',
                        required: false,
                        schema: {
                            $ref: '#/components/schemas/SearchRequest/properties/provider',
                        },
                    },
                    {
                        name: 'maxResults',
                        in: 'query',
                        required: false,
                        schema: {
                            $ref: '#/components/schemas/SearchRequest/properties/maxResults',
                        },
                    },
                    {
                        name: 'languageCode',
                        in: 'query',
                        required: false,
                        schema: {
                            $ref: '#/components/schemas/SearchRequest/properties/languageCode',
                        },
                    },
                    {
                        name: 'countryCode',
                        in: 'query',
                        required: false,
                        schema: {
                            $ref: '#/components/schemas/SearchRequest/properties/countryCode',
                        },
                    },
                    {
                        name: 'location',
                        in: 'query',
                        required: false,
                        schema: {
                            $ref: '#/components/schemas/SearchRequest/properties/location',
                        },
                    },
                    {
                        name: 'dateFrom',
                        in: 'query',
                        required: false,
                        schema: {
                            $ref: '#/components/schemas/SearchRequest/properties/dateFrom',
                        },
                    },
                    {
                        name: 'dateTo',
                        in: 'query',
                        required: false,
                        schema: {
                            $ref: '#/components/schemas/SearchRequest/properties/dateTo',
                        },
                    },
                    {
                        name: 'allowedDomains',
                        in: 'query',
                        required: false,
                        style: 'form',
                        explode: false,
                        description: 'Comma-separated list of hostnames, e.g. `example.com,example.org`.',
                        schema: {
                            $ref: '#/components/schemas/SearchRequest/properties/allowedDomains',
                        },
                    },
                    {
                        name: 'blockedDomains',
                        in: 'query',
                        required: false,
                        style: 'form',
                        explode: false,
                        description: 'Comma-separated list of hostnames, e.g. `pinterest.com,reddit.com`.',
                        schema: {
                            $ref: '#/components/schemas/SearchRequest/properties/blockedDomains',
                        },
                    },
                ],
            },
            post: {
                summary: 'Run a search',
                description:
                    'Runs one search and returns the same results as `GET /`. Unlike `GET`, the parameters ' +
                    'are sent as a JSON object in the request body, so array fields such as `allowedDomains` ' +
                    'are real JSON arrays rather than comma-separated strings.',
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                $ref: '#/components/schemas/SearchRequest',
                            },
                            example: {
                                query: 'latest AI agent payment protocols',
                            },
                        },
                    },
                },
            },
        },
    },
    components: {
        schemas: {
            SearchRequest: {
                type: 'object',
                required: ['query'],
                properties: {
                    query: {
                        type: 'string',
                        description:
                            'Operators like `site:` pass through unchecked. Use `allowedDomains` and ' +
                            '`blockedDomains` to enforce domain filters, and `dateFrom` and `dateTo` for dates.',
                        example: 'latest AI agent payment protocols',
                    },
                    provider: {
                        type: 'string',
                        description:
                            '`google` is the default search engine, supports `location`, and returns the most data. ' +
                            '`duckduckgo` has no `location`, covers fewer countries, and fills fewer fields. Use it ' +
                            'for a second, independent ranking, or when Google finds nothing. Each search is charged ' +
                            'separately.',
                        enum: ['google', 'duckduckgo'],
                        default: 'google',
                    },
                    maxResults: {
                        type: 'integer',
                        description:
                            'Maximum number of organic results to return. Omit it to get every result on the page. ' +
                            'You get fewer when the page has fewer, or when domain filters remove some.',
                        minimum: 1,
                    },
                    languageCode: {
                        type: 'string',
                        description:
                            'ISO 639-1 code with an optional region suffix, like `en`, `de`, or `pt-BR`. See ' +
                            'https://en.wikipedia.org/wiki/List_of_ISO_639_language_codes. Google uses it to ' +
                            'localize the interface and bias ranking, without translating or strictly filtering ' +
                            "results. DuckDuckGo picks the matching regional variant, or the country's default.",
                        default: 'en',
                    },
                    countryCode: {
                        type: 'string',
                        description:
                            'ISO 3166-1 alpha-2 code, like `US`, `DE`, or `CZ`. The search runs as if you were in ' +
                            'that country, changing result order and which local businesses appear. Google queries ' +
                            "that country's domain (`google.de` for `DE`). DuckDuckGo picks the matching region, " +
                            "preferring the `languageCode` variant (`CA` with `fr`) over the default. Results aren't " +
                            'limited to sites hosted or registered there. Web Search returns `INVALID_COUNTRY` if ' +
                            'the provider has no market there.',
                        default: 'US',
                    },
                    location: {
                        type: 'string',
                        description:
                            'A place name, most specific first, like `Paris, Ile-de-France, France`. Google treats ' +
                            'it as your location for local and "near me" results. It doesn\'t filter pages. It\'s ' +
                            "best-effort and not validated: Google may ignore places it can't resolve. Using it with " +
                            'DuckDuckGo returns `INVALID_PARAMETER`.',
                    },
                    dateFrom: {
                        type: 'string',
                        pattern: '^\\d{4}-\\d{2}-\\d{2}$',
                        description: 'The earliest publication date to include, as `YYYY-MM-DD`. Best-effort.',
                    },
                    dateTo: {
                        type: 'string',
                        pattern: '^\\d{4}-\\d{2}-\\d{2}$',
                        description: 'The latest publication date to include, as `YYYY-MM-DD`. Best-effort.',
                    },
                    allowedDomains: {
                        type: 'array',
                        description:
                            'Return only results from these domains. You can list up to 10 domains. A domain matches ' +
                            'itself and its subdomains, so `wikipedia.org` covers `en.wikipedia.org`. A top-level ' +
                            'domain like `gov` matches every domain under it.',
                        items: {
                            type: 'string',
                        },
                        maxItems: 10,
                    },
                    blockedDomains: {
                        type: 'array',
                        description:
                            'Exclude results from these domains. You can list up to 10 domains. Matching works like ' +
                            '`allowedDomains`, including subdomains and top-level domains.',
                        items: {
                            type: 'string',
                        },
                        maxItems: 10,
                    },
                },
            },
        },
    },
};

/** `count` documented paths, `/path-0`, `/path-1`, …, each with a bare GET. */
function pathsOf(count: number): Record<string, unknown> {
    return Object.fromEntries(Array.from({ length: count }, (_, i) => [`/path-${i}`, { get: {} }]));
}

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

    it('serves apify/rag-web-browser as a Server Actor tool that names no other web Actor', async () => {
        const [username, name] = RAG_WEB_BROWSER.split('/');
        const { tools } = await loadTools(SCHEMA, { actor: { username, name } });

        expect(tools.map((tool) => tool.type)).toEqual([TOOL_TYPE.ACTOR_SERVER]);
        expect(tools[0].description).not.toContain(WEB_FETCH);
    });

    // A definition built before the tool info existed, such as one restored from a cache, has no tool to serve.
    it('reports a Server Actor whose definition carries no tool instead of dropping it', async () => {
        const actor = mockActor({
            id: 'stale-server-actor',
            name: 'stale-server-actor',
            isPublic: true,
            actorStandby: { isEnabled: true },
        });
        const { apifyClient } = mockActorBuildClient({
            actor,
            defaultBuild: mockDefaultBuild({ webServerSchema: SCHEMA }),
        });
        const actorName = `${actor.username}/${actor.name}`;
        await getActorsAsTools([actorName], apifyClient);
        const cached = actorDefinitionCache.get(actorName)!;
        actorDefinitionCache.set(actorName, {
            ...cached,
            definition: { ...cached.definition, webServerToolInfo: undefined },
        });

        const { tools, errors } = await getActorsAsTools([actorName], apifyClient);

        expect(tools).toEqual([]);
        expect(errors).toMatchObject([{ kind: ACTOR_LOAD_ERROR_KIND.LOAD_FAILED, actorName }]);
    });

    it('is not served in a payment-provider session', async () => {
        const { tools, errors } = await loadTools(SCHEMA, { hasPaymentProvider: true });

        expect(tools).toEqual([]);
        expect(errors.map((error) => error.kind)).toEqual([ACTOR_LOAD_ERROR_KIND.STANDBY_PAYMENT_NOT_SUPPORTED]);
    });
});

describe('the input schema of a Server Actor tool', () => {
    const schemasOf = (info: Partial<ServerActorToolInfo>) =>
        buildServerActorToolSchemas({ methods: ['GET'], hasRequestBody: false, ...info });

    it('narrows the method to the documented ones, and requires the method and the path', () => {
        const { inputSchema, ajvValidate } = schemasOf({ methods: ['GET', 'POST'], hasRequestBody: true });

        expect(inputSchema.properties).toMatchObject({ method: { enum: ['GET', 'POST'] } });
        expect(inputSchema.required).toEqual(['method', 'path']);
        expect(ajvValidate({ method: 'DELETE', path: '/add' })).toBe(false);
    });

    // The Actor Server answers an unknown path with a 404, and the send tool adds the recovery text.
    it('takes the path as a plain string that points at the operations in the description', () => {
        const { inputSchema, ajvValidate } = schemasOf({});
        const path = inputSchema.properties?.path as Record<string, unknown>;

        expect(path).toMatchObject({ type: 'string', minLength: 1 });
        expect(path).not.toHaveProperty('enum');
        expect(ajvValidate({ method: 'GET', path: '/status/404' })).toBe(true);
    });

    it('defaults a single method, which the validator fills in', () => {
        const { inputSchema, ajvValidate } = schemasOf({ methods: ['POST'] });
        const args: Record<string, unknown> = { path: '/' };

        expect(inputSchema.properties).toMatchObject({ method: { default: 'POST' } });
        expect(ajvValidate(args)).toBe(true);
        expect(args).toEqual({ method: 'POST', path: '/' });
    });

    it('leaves the body out when no operation takes one', () => {
        expect(schemasOf({ hasRequestBody: false }).inputSchema.properties).not.toHaveProperty('body');
    });
});

describe('the length of a Server Actor tool description', () => {
    const HEAD = 'Operations:\n';
    const HINT = 'fetch-actor-details returns one operation in full.';
    const LIST_HINT = 'fetch-actor-details lists every operation.';
    const LINES = ['- GET /a: A.', '- GET /b: B.', '- GET /c: C.'];
    const infoWith = (fullLength: number, overrides: Partial<ServerActorToolInfo> = {}): ServerActorToolInfo => ({
        methods: ['GET'],
        hasRequestBody: false,
        fullOperations: 'f'.repeat(fullLength),
        operationLines: LINES,
        operationCount: LINES.length,
        detailsHint: HINT,
        listHint: LIST_HINT,
        ...overrides,
    });

    it('carries every operation in full when the whole description is at the limit', () => {
        const info = infoWith(CLIENT_DESCRIPTION_MAX_LENGTH - HEAD.length);

        expect(buildServerActorToolDescription(HEAD, info, true)).toBe(`${HEAD}${info.fullOperations}`);
    });

    it('lists one line per operation, then how to get one in full, when the full description would be one character over', () => {
        const info = infoWith(CLIENT_DESCRIPTION_MAX_LENGTH - HEAD.length + 1);

        expect(buildServerActorToolDescription(HEAD, info, true)).toBe(`${HEAD}${LINES.join('\n')}\n${HINT}`);
    });

    it('cuts the lines at the limit, counts the operations left out and points at the list of them all', () => {
        const kept = `${LINES[0]}\n… and 2 more`;
        // Room for exactly one line, its newline and the cut line.
        const head = 'h'.repeat(CLIENT_DESCRIPTION_MAX_LENGTH - kept.length - `\n${LIST_HINT}`.length);

        const description = buildServerActorToolDescription(head, infoWith(CLIENT_DESCRIPTION_MAX_LENGTH), true);

        expect(description).toBe(`${head}${kept}\n${LIST_HINT}`);
        expect(description.length).toBe(CLIENT_DESCRIPTION_MAX_LENGTH);
    });

    it('leaves out a line that is one character over the limit, its newline included', () => {
        const head = 'h'.repeat(CLIENT_DESCRIPTION_MAX_LENGTH - `${LINES[0]}\n… and 2 more\n${LIST_HINT}`.length + 1);

        const description = buildServerActorToolDescription(head, infoWith(CLIENT_DESCRIPTION_MAX_LENGTH), true);

        expect(description).toBe(`${head}… and 3 more\n${LIST_HINT}`);
    });

    it('keeps the count of all operations when the fixed text alone exceeds the limit', () => {
        const head = 'h'.repeat(CLIENT_DESCRIPTION_MAX_LENGTH);

        expect(buildServerActorToolDescription(head, infoWith(1), false)).toBe(`${head}… and 3 more`);
    });
});

describe('the operations in a Server Actor tool description', () => {
    it('are the operations in full when they fit, with no lookup to point at', async () => {
        const tool = await loadServerTool(SCHEMA);

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

    it('names send-server-actor-request only when the session has it', async () => {
        const tool = await loadServerTool(SCHEMA);

        expect(tool.buildDescription?.(only(HELPER_TOOLS.ACTOR_SERVER_REQUEST))).toContain(
            HELPER_TOOLS.ACTOR_SERVER_REQUEST,
        );
        expect(tool.buildDescription?.(only())).not.toContain(HELPER_TOOLS.ACTOR_SERVER_REQUEST);
    });

    it('point at the list of every operation when the lines are cut', async () => {
        const tool = await loadServerTool({ paths: pathsOf(1000) });

        expect(tool.buildDescription?.(only(HELPER_TOOLS.ACTOR_GET_DETAILS))).toMatch(
            new RegExp(
                `… and \\d+ more\n${HELPER_TOOLS.ACTOR_GET_DETAILS} with .*"serverInterface":true}} lists every operation\\.$`,
            ),
        );
    });

    // The tool has no body argument for it, and it sends only JSON.
    it('mark a body that is not JSON, such as a form, as not supported', () => {
        const form = { 'application/x-www-form-urlencoded': {} };
        const info = infoOf({
            paths: {
                '/login': { post: { summary: 'Log in', requestBody: { required: true, content: form } } },
                '/note': { post: { requestBody: { content: form } } },
            },
        });

        expect(info.operationLines).toEqual([
            '- POST /login {required application/x-www-form-urlencoded body: not supported}: Log in.',
            '- POST /note {application/x-www-form-urlencoded body: not supported}',
        ]);
        expect(info.hasRequestBody).toBe(false);
    });

    it('keep only what can fit the description limit', () => {
        const count = 1000;

        const info = infoOf({ paths: pathsOf(count) });

        expect(info.fullOperations).toBeUndefined();
        expect(info.operationCount).toBe(count);
        expect(info.operationLines.join('\n').length).toBeLessThanOrEqual(CLIENT_DESCRIPTION_MAX_LENGTH);
        expect(info.operationLines.length).toBeLessThan(count);
    });

    it('keeps required body properties beside a referenced schema alias', () => {
        const info = infoOf({
            paths: {
                '/fetch': {
                    post: {
                        requestBody: {
                            required: true,
                            content: { 'application/json': { schema: { $ref: '#/components/schemas/Fetch' } } },
                        },
                    },
                },
            },
            components: {
                schemas: {
                    Fetch: {
                        $ref: '#/components/schemas/Base',
                        properties: { url: { type: 'string' } },
                        required: ['url'],
                    },
                    Base: { type: 'object' },
                },
            },
        });

        expect(info.operationLines).toEqual(['- POST /fetch {url:string required}']);
    });

    it('keeps the parameter type beside a referenced schema alias', () => {
        const info = infoOf({
            paths: {
                '/search': {
                    get: {
                        parameters: [{ name: 'count', in: 'query', schema: { $ref: '#/components/schemas/Count' } }],
                    },
                },
            },
            components: {
                schemas: {
                    Count: { $ref: '#/components/schemas/Number', type: 'integer' },
                    Number: { type: 'number' },
                },
            },
        });

        expect(info.operationLines).toEqual(['- GET /search [count:integer]']);
    });

    it('avoids reading body properties for every documented operation', () => {
        const count = 1000;
        let propertyReads = 0;
        const schema = {
            paths: Object.fromEntries(
                Array.from({ length: count }, (_, i) => [
                    `/path-${i}`,
                    { post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/body' } } } } } },
                ]),
            ),
            body: {
                type: 'object',
                // Count reads rather than rely on timing or garbage collection.
                get properties() {
                    propertyReads += 1;
                    return { url: { type: 'string' } };
                },
            },
        };

        const info = infoOf(schema);

        expect(info.hasRequestBody).toBe(true);
        expect(info.operationLines.length).toBeLessThan(count);
        expect(propertyReads).toBeLessThan(count);
    });

    it('finds a JSON body after the operation lines are cut', () => {
        const info = infoOf({
            paths: {
                ...pathsOf(1000),
                '/submit': { post: { requestBody: { content: { 'application/json': {} } } } },
            },
        });

        expect(info.hasRequestBody).toBe(true);
        expect(info.operationLines.join('\n')).not.toContain('/submit');
    });

    it('come with the documented methods, and whether an operation takes a body', () => {
        expect(infoOf(SCHEMA)).toMatchObject({ methods: ['GET', 'POST'], hasRequestBody: true });
        expect(buildServerActorToolInfo({ paths: {} }, 'apify/server-actor-test')).toBeUndefined();
    });
});

describe('the default apify/web-fetch tool', () => {
    const [username, name] = WEB_FETCH.split('/');
    const webFetchActor: Partial<Actor> = {
        username,
        name,
        description:
            'Download any web page by URL and convert it to clean Markdown, plain text, HTML, and other formats. ' +
            'Automatically renders JavaScript and works around bot blocking. The Actor provides a real-time API ' +
            'for quick response times.',
        actorStandby: { isEnabled: true, tenancy: 'MULTI_TENANT' },
    };
    const loadWebFetchTool = () => loadServerTool(WEB_FETCH_LIVE_SCHEMA, webFetchActor);

    // No web-fetch exception: the tool is what any Server Actor with this schema gets.
    it('is served as a Server Actor tool: GET or POST, a required path, a body, and an untyped query', async () => {
        const tool = await loadWebFetchTool();

        expect(tool.type).toBe(TOOL_TYPE.ACTOR_SERVER);
        expect(tool.inputSchema.properties).toMatchObject({
            method: { enum: ['GET', 'POST'] },
            path: { type: 'string' },
        });
        expect(tool.inputSchema.properties).toHaveProperty('body');
        expect(tool.inputSchema.properties?.query).not.toHaveProperty('properties');
        expect(tool.inputSchema.required).toEqual(['method', 'path']);
        expect(
            tool.ajvValidate({
                method: 'GET',
                path: '/',
                query: { url: 'https://example.com', formats: ['markdown'] },
            }),
        ).toBe(true);
        expect(tool.ajvValidate({ query: { url: 'https://example.com' } })).toBe(false);
    });

    // The session may not serve the web search tool, and a description names no absent tool.
    it('names the web search tool only when the session has it', async () => {
        const tool = await loadWebFetchTool();
        const webSearchTool = actorNameToToolName(WEB_SEARCH);

        expect(tool.buildDescription?.(only(webSearchTool))).toContain(webSearchTool);
        expect(tool.buildDescription?.(only())).not.toContain(webSearchTool);
    });

    it('keeps the read-only hint of the Actor', async () => {
        const tool = await loadWebFetchTool();

        expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    });

    it('lists formats as the comma-joined query parameter of GET /', () => {
        expect(listCommaJoinedQueryParameters(WEB_FETCH_LIVE_SCHEMA)).toEqual({ 'GET /': ['formats'] });
    });

    // Without its server interface the Actor is a run tool again, whose input is the Actor's own schema.
    it('falls back to a run tool without the server example when Actor Standby is off', async () => {
        const { tools } = await loadTools(WEB_FETCH_LIVE_SCHEMA, {
            actor: { ...webFetchActor, actorStandby: { isEnabled: false } },
        });

        expect(tools.map((tool) => tool.type)).toEqual([TOOL_TYPE.ACTOR]);
        expect(tools[0].description).not.toContain('"method"');
    });
});

describe('the default apify/web-search tool', () => {
    const [username, name] = WEB_SEARCH.split('/');
    const webSearchActor: Partial<Actor> = {
        username,
        name,
        description:
            'Search the web and get organic results as JSON with title, URL, snippet, and position. You can filter ' +
            'by date, country, language, and domain. The Actor provides a real-time API.',
        actorStandby: { isEnabled: true, tenancy: 'MULTI_TENANT' },
    };
    // The Actor is also an MCP server; the server interface takes its tool slot.
    const loadWebSearchTool = async () => {
        const { tools } = await loadTools(WEB_SEARCH_LIVE_SCHEMA, { actor: webSearchActor, webServerMcpPath: '/mcp' });
        expect(tools).toHaveLength(1);
        return tools[0];
    };

    it('is served as a Server Actor tool: GET or POST, a required path, a body, and an untyped query', async () => {
        const tool = await loadWebSearchTool();

        expect(tool.type).toBe(TOOL_TYPE.ACTOR_SERVER);
        expect(tool.inputSchema.properties).toMatchObject({
            method: { enum: ['GET', 'POST'] },
            path: { type: 'string' },
        });
        expect(tool.inputSchema.properties).toHaveProperty('body');
        expect(tool.inputSchema.properties?.query).not.toHaveProperty('properties');
        expect(tool.inputSchema.required).toEqual(['method', 'path']);
        expect(
            tool.ajvValidate({
                method: 'GET',
                path: '/',
                query: { query: 'apify', maxResults: 2, allowedDomains: ['apify.com', 'docs.apify.com'] },
            }),
        ).toBe(true);
    });

    // The session may not serve the other web Actor tools, and a description names no absent tool.
    it('names the web fetch tool only when the session has it, and rag-web-browser never', async () => {
        const tool = await loadWebSearchTool();
        const webFetchTool = actorNameToToolName(WEB_FETCH);

        expect(tool.buildDescription?.(only(webFetchTool))).toContain(webFetchTool);
        expect(tool.buildDescription?.(only())).not.toContain(webFetchTool);
        expect(tool.description).not.toContain(RAG_WEB_BROWSER);
    });

    // The policy replaces the generic Server Actor input text with the tool's own.
    it('describes its own query input', async () => {
        const tool = await loadWebSearchTool();
        const generic = buildServerActorToolSchemas({ methods: ['GET'], hasRequestBody: false }).inputSchema.properties
            ?.query as { description: string };
        const query = tool.inputSchema.properties?.query as { description: string };

        expect(query.description).not.toBe(generic.description);
    });

    it('keeps the read-only hint of the Actor', async () => {
        const tool = await loadWebSearchTool();

        expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    });

    it('lists allowedDomains and blockedDomains as the comma-joined query parameters of GET /', () => {
        expect(listCommaJoinedQueryParameters(WEB_SEARCH_LIVE_SCHEMA)).toEqual({
            'GET /': ['allowedDomains', 'blockedDomains'],
        });
    });
});

// Clients with a pre-0.21 tool list still call the default tool that apify--web-search replaced.
describe('a call to the removed default apify--rag-web-browser', () => {
    const callRagWebBrowser = async (
        sessionActors: string[],
        args: Record<string, unknown> = { query: 'apify', maxResults: 3 },
        // The engine reads only the names of a default session's other tools.
        internalTools = [...resolveToolNamesFromInput({})].map((toolName) => ({ name: toolName }) as ToolEntry),
    ) => {
        const [username, name] = RAG_WEB_BROWSER.split('/');
        // Caches the public rag-web-browser definition, so the engine loads the tool without the Apify API.
        await loadTools(SCHEMA, { actor: { username, name, isPublic: true } });
        const sessionTools = await Promise.all(
            sessionActors.map(async (actorName) => {
                const [actorUsername, actorShortName] = actorName.split('/');
                return loadServerTool(SCHEMA, { username: actorUsername, name: actorShortName });
            }),
        );
        return prepareToolCall({
            tools: new Map([...internalTools, ...sessionTools].map((tool) => [tool.name, tool])),
            apifyToken: 'fake-token',
            name: actorNameToToolName(RAG_WEB_BROWSER),
            args,
            meta: undefined,
            requestHeaders: undefined,
            isTaskRequest: false,
            mcpSessionId: 's1',
            telemetryData: null,
            clientContext: undefined,
        });
    };

    it('runs rag-web-browser with the run input sent as GET /search in a default session', async () => {
        const prepared = (await callRagWebBrowser(defaults.actors)) as PreparedCall;

        expect(prepared.tool.name).toBe(actorNameToToolName(RAG_WEB_BROWSER));
        expect(prepared.toolArgs).toEqual({ method: 'GET', path: '/search', query: { query: 'apify', maxResults: 3 } });
        expect(prepared.compatibilityNote).toContain(actorNameToToolName(WEB_SEARCH));
    });

    it('keeps the example call when the arguments fail validation', async () => {
        const result = (await callRagWebBrowser(defaults.actors, { waitSecs: 10 })) as InvalidToolCall;

        expect(result.message).toContain(`Invalid arguments for tool "${actorNameToToolName(RAG_WEB_BROWSER)}"`);
        expect(result.message).toContain('Example call: {"method":"GET","path":"/search"');
        expect(result.message).toContain(actorNameToToolName(WEB_SEARCH));
    });

    // A session whose tools were chosen without the defaults never had rag-web-browser.
    it('is not found in a session that selected only apify/web-search', async () => {
        const result = await callRagWebBrowser([WEB_SEARCH], undefined, []);

        expect((result as InvalidToolCall).message).toContain(
            `Tool "${actorNameToToolName(RAG_WEB_BROWSER)}" was not found`,
        );
    });
});
