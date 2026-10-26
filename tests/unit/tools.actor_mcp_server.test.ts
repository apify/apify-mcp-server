import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
    CallToolRequestSchema,
    type CallToolResult,
    ErrorCode,
    type InitializeRequest,
    ListToolsRequestSchema,
    McpError,
    type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApifyClient, REQUEST_ORIGIN } from '../../src/apify_client.js';
import { APIFY_AI_CLIENT_NAME, FAILURE_CATEGORY, HELPER_TOOLS, TOOL_STATUS } from '../../src/const.js';
import { connectMCPClient } from '../../src/mcp/client.js';
import { EXTERNAL_TOOL_CALL_TIMEOUT_MSEC } from '../../src/mcp/const.js';
import { actorDefinitionCache } from '../../src/state.js';
import { callActorMcpTool, executeCallActorMcpTool } from '../../src/tools/actors/call_actor_mcp_tool.js';
import {
    executeFetchActorMcpToolList,
    fetchActorMcpToolList,
    MAX_TOOL_LIST_PAGES,
} from '../../src/tools/actors/fetch_actor_mcp_tool_list.js';
import type { Actor, ActorDefinitionPruned, HelperTool, ToolEntry, ToolTelemetryContext } from '../../src/types.js';
import { ALL_TOOLS_PRESENT, SERVER_MODE } from '../../src/types.js';
import { mockActor } from './helpers/actor_build_client.js';
import { getRequestHandler, makePaymentProvider, withServer } from './helpers/mcp_server.js';
import { expectSoftFailInvalidInput, mockApifyClient, only, stubToolCallContext } from './helpers/tool_context.js';

const TOKEN = 'test-token';
const MCP_ACTOR = 'apify/example-mcp-server';

/** What the remote server returns per tool; `add` carries text and resource content, structuredContent and _meta. */
const REMOTE_RESULTS: Record<string, CallToolResult> = {
    add: {
        content: [
            { type: 'text', text: 'The sum of 2 and 3 is 5' },
            { type: 'resource', resource: { uri: 'memo://sum', mimeType: 'text/plain', text: '5' } },
        ],
        structuredContent: { sum: 5 },
        _meta: { 'example/trace': 'abc' },
    },
    fail: { content: [{ type: 'text', text: 'firstNumber is required' }], isError: true },
    // A key the server reads as its own internal telemetry.
    spoof: { content: [], toolTelemetry: { toolStatus: 'FAILED', actorId: 'spoofed' } },
};

/**
 * The two pages of `tools/list` on `/mcp`; `add` also carries a title, an output schema, annotations and `_meta`, and
 * `subtract` an output schema with a `$ref` that does not resolve.
 */
const REMOTE_TOOL_PAGES: Tool[][] = [
    [
        {
            name: 'add',
            title: 'Add',
            description: 'Adds two numbers.',
            inputSchema: { type: 'object', properties: { firstNumber: { type: 'number' } } },
            outputSchema: { type: 'object', properties: { sum: { type: 'number' } } },
            annotations: { readOnlyHint: true },
            _meta: { 'example/version': '1' },
        },
    ],
    [
        {
            name: 'subtract',
            inputSchema: { type: 'object' },
            outputSchema: { type: 'object', properties: { difference: { $ref: '#/$defs/missing' } } },
        },
    ],
];

type ToolResult = Record<string, unknown> & { toolTelemetry?: ToolTelemetryContext };

/** Since the test started: the headers of every request to the remote servers, and each tools/call and tools/list. */
let requestHeaders: IncomingMessage['headers'][] = [];
let remoteCalls: { name: string; arguments: unknown }[] = [];
let listCursors: (string | undefined)[] = [];
let httpServer: HttpServer;
let standbyUrl: string;

function waitForAbort(signal: AbortSignal): Promise<{ content: []; tools: [] }> {
    return new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve({ content: [], tools: [] }));
    });
}

/**
 * The Actor's MCP server, by path: `/mcp` serves `REMOTE_RESULTS` and `REMOTE_TOOL_PAGES` (an unknown tool or
 * cursor is a JSON-RPC error), `/mcp-broken-pages` fails the second page, `/mcp-endless` never runs out of
 * cursors, and `/mcp-slow` answers only once the request is cancelled.
 */
function createRemoteServer(path: string | undefined): Server {
    const server = new Server({ name: 'example-mcp-server', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
        remoteCalls.push({ name: params.name, arguments: params.arguments });
        if (path === '/mcp-slow') return waitForAbort(extra.signal);
        const result = REMOTE_RESULTS[params.name];
        if (!result) throw new McpError(ErrorCode.InvalidParams, `Tool ${params.name} not found`);
        return result;
    });
    server.setRequestHandler(ListToolsRequestSchema, async ({ params }, extra) => {
        listCursors.push(params?.cursor);
        if (path === '/mcp-slow') return waitForAbort(extra.signal);
        if (path === '/mcp-endless') return { tools: [], nextCursor: 'more' };
        if (params?.cursor === undefined) return { tools: REMOTE_TOOL_PAGES[0], nextCursor: 'page-2' };
        if (params.cursor === 'page-2' && path === '/mcp') return { tools: REMOTE_TOOL_PAGES[1] };
        throw new McpError(ErrorCode.InvalidParams, `Invalid cursor ${params.cursor}`);
    });
    return server;
}

function seedActor(
    name: string,
    overrides: { actor?: Partial<Actor>; definition?: Partial<ActorDefinitionPruned> } = {},
): void {
    const [username, actorName] = name.split('/');
    const info = mockActor({
        id: `${actorName}-id`,
        username,
        name: actorName,
        isPublic: true,
        standbyUrl,
        actorStandby: { isEnabled: true },
        ...overrides.actor,
    });
    const definition: ActorDefinitionPruned = {
        id: info.id,
        actorFullName: name,
        buildTag: 'latest',
        readme: '',
        description: '',
        defaultRunOptions: { build: 'latest', memoryMbytes: 256, timeoutSecs: 300 },
        webServerMcpPath: '/mcp',
        hasWebServerSchema: false,
        ...overrides.definition,
    };
    actorDefinitionCache.set(name, { definition, info });
}

async function execute(
    run: HelperTool['call'],
    args: Record<string, unknown>,
    options: { signal?: AbortSignal; token?: string; apifyClient?: ApifyClient } = {},
): Promise<ToolResult> {
    const context = stubToolCallContext(
        { actor: MCP_ACTOR, ...args },
        options.apifyClient ?? new ApifyClient({ token: TOKEN }),
    );
    if (options.signal) context.signal = options.signal;
    if (options.token !== undefined) context.apifyToken = options.token;
    return (await run(context)) as ToolResult;
}

async function dispatch(
    tool: ToolEntry,
    args: Record<string, unknown>,
    serverOptions: Parameters<typeof withServer>[1] = { token: TOKEN },
): Promise<Record<string, unknown>> {
    return withServer(async (server) => {
        server.upsertTools([tool]);
        return getRequestHandler(server, 'tools/call')(
            { method: 'tools/call', params: { name: tool.name, arguments: args, _meta: { mcpSessionId: 's1' } } },
            { signal: new AbortController().signal, sendNotification: vi.fn() },
        );
    }, serverOptions);
}

beforeAll(async () => {
    httpServer = createServer((req, res) => {
        const path = req.url?.split('?')[0];
        requestHeaders.push(req.headers);
        const remote = createRemoteServer(path);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => void remote.close());
        void remote.connect(transport).then(async () => transport.handleRequest(req, res));
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    standbyUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
    seedActor(MCP_ACTOR);
});

afterAll(async () => {
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

afterEach(() => {
    vi.restoreAllMocks();
});

beforeEach(() => {
    requestHeaders = [];
    remoteCalls = [];
    listCursors = [];
});

describe('call-actor-mcp-tool', () => {
    it('returns the remote CallToolResult unchanged, with no run fields', async () => {
        const result = await dispatch(callActorMcpTool, {
            actor: MCP_ACTOR,
            tool: 'add',
            arguments: { a: 2, b: 3 },
        });

        expect(result).toEqual(REMOTE_RESULTS.add);
        expect(remoteCalls).toEqual([{ name: 'add', arguments: { a: 2, b: 3 } }]);
    });

    it("passes the remote tool's error flag through, recorded as an internal error", async () => {
        const result = await execute(executeCallActorMcpTool, { tool: 'fail' });

        expect(result).toMatchObject(REMOTE_RESULTS.fail);
        expect(result.toolTelemetry).toEqual({
            toolStatus: TOOL_STATUS.SOFT_FAIL,
            failureCategory: FAILURE_CATEGORY.INTERNAL_ERROR,
            actorId: 'example-mcp-server-id',
        });
    });

    it("ignores a toolTelemetry key in the remote result, so the remote cannot write the server's telemetry", async () => {
        const result = await execute(executeCallActorMcpTool, { tool: 'spoof' });

        expect(result.toolTelemetry).toEqual({ actorId: 'example-mcp-server-id' });
    });

    it('sends omitted arguments as an empty object', async () => {
        await execute(executeCallActorMcpTool, { tool: 'add' });

        expect(remoteCalls).toEqual([{ name: 'add', arguments: {} }]);
    });

    it('sends the session token and the MCP request origin on every request of the connection', async () => {
        await execute(executeCallActorMcpTool, { tool: 'add' });

        expect(requestHeaders.length).toBeGreaterThan(0);
        for (const headers of requestHeaders) {
            expect(headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, 'x-apify-request-origin': 'MCP' });
        }
    });

    it('sends APIFY_AI as the request origin of the MCP connection for an Apify AI client session', async () => {
        await dispatch(
            callActorMcpTool,
            { actor: MCP_ACTOR, tool: 'add' },
            {
                token: TOKEN,
                initializeRequestData: {
                    method: 'initialize',
                    params: {
                        protocolVersion: '2025-06-18',
                        clientInfo: { name: APIFY_AI_CLIENT_NAME, version: '1.0.0' },
                        capabilities: {},
                    },
                } as InitializeRequest,
            },
        );

        expect(requestHeaders.length).toBeGreaterThan(0);
        for (const headers of requestHeaders) expect(headers['x-apify-request-origin']).toBe('APIFY_AI');
    });

    it('passes the external tool-call timeout to tools/call', async () => {
        const callToolSpy = vi.spyOn(Client.prototype, 'callTool');

        await execute(executeCallActorMcpTool, { tool: 'add' });

        expect(callToolSpy.mock.calls[0][2]).toMatchObject({ timeout: EXTERNAL_TOOL_CALL_TIMEOUT_MSEC });
    });

    it('reports a JSON-RPC error from the remote server as a failed call of that tool', async () => {
        const result = await execute(executeCallActorMcpTool, { tool: 'subtract' });

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain(`Failed to call MCP tool 'subtract' on Actor '${MCP_ACTOR}'`);
    });

    it('returns the not-found response for an Actor the API does not know, without connecting', async () => {
        const unknownActorClient = Object.assign(
            new ApifyClient({ token: TOKEN }),
            mockApifyClient({ actor: () => ({ get: async () => undefined }) }),
        );

        const result = await execute(
            executeCallActorMcpTool,
            { tool: 'add', actor: 'apify/missing' },
            { apifyClient: unknownActorClient },
        );

        expectSoftFailInvalidInput(result);
        expect(requestHeaders).toHaveLength(0);
    });

    it('rejects an MCP path that leaves the standby origin without connecting, and reports the Actor ID', async () => {
        seedActor('apify/off-origin-mcp-server', { definition: { webServerMcpPath: 'https://elsewhere.example/mcp' } });

        const result = await execute(executeCallActorMcpTool, { tool: 'add', actor: 'apify/off-origin-mcp-server' });

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain('resolves outside its standby origin');
        expect(result.toolTelemetry).toMatchObject({ actorId: 'off-origin-mcp-server-id' });
        expect(requestHeaders).toHaveLength(0);
    });

    it('requires a token without connecting', async () => {
        const result = await dispatch(
            callActorMcpTool,
            { actor: MCP_ACTOR, tool: 'add' },
            { token: '', allowUnauthMode: true },
        );

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain('An Apify API token is required');
        expect(requestHeaders).toHaveLength(0);
    });

    it('reports a server that cannot be reached as a connection failure', async () => {
        const closed = createServer();
        await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
        const { port } = closed.address() as AddressInfo;
        await new Promise<void>((resolve) => closed.close(() => resolve()));
        seedActor('apify/unreachable-mcp-server', { actor: { standbyUrl: `http://127.0.0.1:${port}` } });

        const result = await execute(executeCallActorMcpTool, {
            tool: 'add',
            actor: 'apify/unreachable-mcp-server',
        });

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain('Failed to connect to MCP server');
    });

    it('does not connect when the call is already cancelled', async () => {
        const controller = new AbortController();
        controller.abort();

        expect(await execute(executeCallActorMcpTool, { tool: 'add' }, { signal: controller.signal })).toEqual({});
        expect(requestHeaders).toHaveLength(0);
    });

    it('names fetch-actor-mcp-tool-list in the description only when the session has it, and states the billing caveat', () => {
        const withList = callActorMcpTool.buildDescription!(ALL_TOOLS_PRESENT);
        const withoutList = callActorMcpTool.buildDescription!(only(HELPER_TOOLS.ACTOR_MCP_TOOL_CALL));

        expect(callActorMcpTool.description).toBe(withList);
        expect(withList).toContain(HELPER_TOOLS.ACTOR_MCP_TOOL_LIST);
        expect(withoutList).not.toContain(HELPER_TOOLS.ACTOR_MCP_TOOL_LIST);
        expect(withList).toContain('Connecting can start a standby run');
    });
});

describe('fetch-actor-mcp-tool-list', () => {
    it("returns every page's tool definitions unchanged, with one text item per tool", async () => {
        const result = await dispatch(fetchActorMcpToolList, { actor: MCP_ACTOR });

        expect(result.structuredContent).toEqual({ tools: REMOTE_TOOL_PAGES.flat() });
        expect(listCursors).toEqual([undefined, 'page-2']);
        const texts = (result.content as { text: string }[]).map(({ text }) => text);
        expect(texts).toEqual([
            "The Actor's MCP server has 2 tools.",
            `add: Adds two numbers.\nInput schema: ${JSON.stringify(REMOTE_TOOL_PAGES[0][0].inputSchema)}`,
            `subtract: No description.\nInput schema: ${JSON.stringify(REMOTE_TOOL_PAGES[1][0].inputSchema)}`,
        ]);
    });

    it('fails the listing when a page fails, without a partial list', async () => {
        seedActor('apify/broken-pages-mcp-server', { definition: { webServerMcpPath: '/mcp-broken-pages' } });

        const result = await execute(executeFetchActorMcpToolList, { actor: 'apify/broken-pages-mcp-server' });

        expect(result.isError).toBe(true);
        expect(result).not.toHaveProperty('structuredContent');
        expect(JSON.stringify(result.content)).toContain('Failed to list the MCP tools on Actor');
    });

    it('fails the listing when the cursors never run out', async () => {
        seedActor('apify/endless-mcp-server', { definition: { webServerMcpPath: '/mcp-endless' } });

        const result = await execute(executeFetchActorMcpToolList, { actor: 'apify/endless-mcp-server' });

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain(`more than ${MAX_TOOL_LIST_PAGES} pages`);
        expect(listCursors).toHaveLength(MAX_TOOL_LIST_PAGES);
    });

    it('gives all tools/list pages one external tool-call timeout and passes each the call signal', async () => {
        // Each page takes a minute, so the second one gets what is left of the timeout.
        const realNow = Date.now.bind(Date);
        let elapsed = 0;
        vi.spyOn(Date, 'now').mockImplementation(() => realNow() + elapsed);
        const { request } = Client.prototype;
        const requestSpy = vi.spyOn(Client.prototype, 'request').mockImplementation(function (this: Client, ...args) {
            if (args[0].method === 'tools/list') elapsed += 60_000;
            return request.apply(this, args);
        });
        const controller = new AbortController();

        await execute(executeFetchActorMcpToolList, {}, { signal: controller.signal });

        const pageOptions = requestSpy.mock.calls
            .filter(([{ method }]) => method === 'tools/list')
            .map(([, , options]) => options);
        expect(pageOptions).toHaveLength(2);
        expect(pageOptions[0]?.timeout).toBeLessThanOrEqual(EXTERNAL_TOOL_CALL_TIMEOUT_MSEC);
        expect(pageOptions[1]?.timeout).toBeLessThanOrEqual(EXTERNAL_TOOL_CALL_TIMEOUT_MSEC - 60_000);
        for (const options of pageOptions) expect(options?.signal).toBe(controller.signal);
    });

    it('discovers again on every call, with nothing cached', async () => {
        await execute(executeFetchActorMcpToolList, {});
        await execute(executeFetchActorMcpToolList, {});

        expect(listCursors).toEqual([undefined, 'page-2', undefined, 'page-2']);
    });

    it('closes the client after a listing that succeeds and after one that fails', async () => {
        seedActor('apify/broken-pages-mcp-server', { definition: { webServerMcpPath: '/mcp-broken-pages' } });
        const closeSpy = vi.spyOn(Client.prototype, 'close');

        await execute(executeFetchActorMcpToolList, {});
        await execute(executeFetchActorMcpToolList, { actor: 'apify/broken-pages-mcp-server' });

        expect(closeSpy).toHaveBeenCalledTimes(2);
    });

    it('names call-actor-mcp-tool in the description only when the session has it, and states the billing caveat', () => {
        const withCall = fetchActorMcpToolList.buildDescription!(ALL_TOOLS_PRESENT);
        const withoutCall = fetchActorMcpToolList.buildDescription!(only(HELPER_TOOLS.ACTOR_MCP_TOOL_LIST));

        expect(fetchActorMcpToolList.description).toBe(withCall);
        expect(withCall).toContain(HELPER_TOOLS.ACTOR_MCP_TOOL_CALL);
        expect(withoutCall).not.toContain(HELPER_TOOLS.ACTOR_MCP_TOOL_CALL);
        expect(withCall).toContain('Connecting can start a standby run');
    });
});

describe.each([
    { tool: callActorMcpTool, run: executeCallActorMcpTool, args: { tool: 'add' } },
    { tool: fetchActorMcpToolList, run: executeFetchActorMcpToolList, args: {} },
])('$tool.name before and during the connection', ({ tool, run, args }) => {
    it('rejects an Actor that is not an MCP server without connecting', async () => {
        seedActor('apify/server-actor-test', { definition: { webServerMcpPath: undefined, hasWebServerSchema: true } });

        const result = await execute(run, { ...args, actor: 'apify/server-actor-test' });

        expectSoftFailInvalidInput(result);
        expect(result.toolTelemetry).toMatchObject({ actorId: 'server-actor-test-id' });
        expect(requestHeaders).toHaveLength(0);
    });

    it('returns the empty aborted response when the client cancels mid-request', async () => {
        seedActor('apify/slow-mcp-server', { definition: { webServerMcpPath: '/mcp-slow' } });
        const controller = new AbortController();

        const pending = execute(run, { ...args, actor: 'apify/slow-mcp-server' }, { signal: controller.signal });
        await vi.waitFor(() => expect(remoteCalls.length + listCursors.length).toBe(1));
        controller.abort();

        expect(await pending).toEqual({});
    });

    it.each([
        ['with a token', { token: TOKEN }],
        ['without a token', { token: undefined }],
    ])('is rejected before connecting in a payment-provider session %s', async (_label, tokenOptions) => {
        const result = await dispatch(
            tool,
            { actor: MCP_ACTOR, ...args },
            { ...tokenOptions, paymentProvider: makePaymentProvider() },
        );

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain('is not supported in agentic payment mode');
        expect(requestHeaders).toHaveLength(0);
    });

    it('is not listed in a payment-provider session', async () => {
        const listActorsTools = async (options: Parameters<typeof withServer>[1]) =>
            withServer(
                async (server) => {
                    await server.loadToolsFromInput({ tools: ['actors'] }, mockApifyClient());
                    return server.listToolNames();
                },
                { serverMode: SERVER_MODE.DEFAULT, ...options },
            );

        expect(await listActorsTools({})).toContain(tool.name);
        expect(await listActorsTools({ paymentProvider: makePaymentProvider() })).not.toContain(tool.name);
    });
});

describe('MCP connection headers', () => {
    it("sends the token and the session's request origin on the SSE fallback too", async () => {
        const seen: { method?: string; headers: IncomingMessage['headers'] }[] = [];
        const notFound = createServer((req, res) => {
            seen.push({ method: req.method, headers: req.headers });
            res.writeHead(404).end();
        });
        await new Promise<void>((resolve) => notFound.listen(0, '127.0.0.1', resolve));

        const client = await connectMCPClient(`http://127.0.0.1:${(notFound.address() as AddressInfo).port}/mcp`, {
            token: TOKEN,
            requestOrigin: REQUEST_ORIGIN.APIFY_AI,
        });
        await new Promise<void>((resolve) => notFound.close(() => resolve()));

        expect(client).toBeNull();
        expect(seen.map(({ method }) => method)).toEqual(['POST', 'GET']);
        for (const { headers } of seen) {
            expect(headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, 'x-apify-request-origin': 'APIFY_AI' });
        }
    });
});
