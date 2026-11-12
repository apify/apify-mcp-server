import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
    CallToolRequestSchema,
    type CallToolResult,
    CancelledNotificationSchema,
    ErrorCode,
    type InitializeRequest,
    ListToolsRequestSchema,
    McpError,
    type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import log from '@apify/log';

import { ApifyClient, REQUEST_ORIGIN } from '../../src/apify_client.js';
import { APIFY_AI_CLIENT_NAME, FAILURE_CATEGORY, HELPER_TOOLS, TOOL_STATUS } from '../../src/const.js';
import { connectMCPClient } from '../../src/mcp/client.js';
import { EXTERNAL_TOOL_CALL_TIMEOUT_MSEC, MAX_ACTOR_MCP_RESPONSE_BYTES } from '../../src/mcp/const.js';
import { actorDefinitionCache } from '../../src/state.js';
import * as telemetry from '../../src/telemetry.js';
import { getMCPServersAsTools } from '../../src/tools/actors/actor_tools_factory.js';
import {
    callActorMcpTool,
    executeCallActorMcpTool,
    MCP_TOOL_NAME_MAX_LENGTH,
} from '../../src/tools/actors/call_actor_mcp_tool.js';
import {
    executeFetchActorMcpToolList,
    fetchActorMcpToolList,
    MAX_TOOL_LIST_PAGES,
} from '../../src/tools/actors/fetch_actor_mcp_tool_list.js';
import type { Actor, ActorDefinitionPruned, HelperTool, ToolEntry, ToolTelemetryContext } from '../../src/types.js';
import { ALL_TOOLS_PRESENT, SERVER_MODE, TOOL_TYPE } from '../../src/types.js';
import { compileSchema } from '../../src/utils/ajv.js';
import { mockActor } from './helpers/actor_build_client.js';
import { getRequestHandler, getTaskStore, makePaymentProvider, withServer } from './helpers/mcp_server.js';
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
/** The reason of each notifications/cancelled the remote servers got. */
let remoteCancellations: string[] = [];
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
 * cursors, and `/mcp-slow` answers only once the request is cancelled. `/mcp-large` (`/mcp-large-json` with a JSON
 * response body) answers every call and listing with a text over `MAX_ACTOR_MCP_RESPONSE_BYTES`, `/mcp-large-pages`
 * lists pages of a quarter of that, and `/mcp-large-init` sends instructions over it in its `initialize` result.
 */
function createRemoteServer(path: string | undefined): Server {
    const server = new Server(
        { name: 'example-mcp-server', version: '1.0.0' },
        {
            capabilities: { tools: {} },
            ...(path === '/mcp-large-init' && { instructions: 'x'.repeat(MAX_ACTOR_MCP_RESPONSE_BYTES) }),
        },
    );
    const isLarge = path === '/mcp-large' || path === '/mcp-large-json';
    server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
        remoteCalls.push({ name: params.name, arguments: params.arguments });
        if (path === '/mcp-slow') return waitForAbort(extra.signal);
        if (isLarge) return { content: [{ type: 'text', text: 'x'.repeat(MAX_ACTOR_MCP_RESPONSE_BYTES) }] };
        const result = REMOTE_RESULTS[params.name];
        if (!result) throw new McpError(ErrorCode.InvalidParams, `Tool ${params.name} not found`);
        return result;
    });
    server.setRequestHandler(ListToolsRequestSchema, async ({ params }, extra) => {
        listCursors.push(params?.cursor);
        if (path === '/mcp-slow') return waitForAbort(extra.signal);
        if (path === '/mcp-endless') return { tools: [], nextCursor: 'more' };
        if (isLarge)
            return {
                tools: [
                    {
                        name: 'add',
                        description: 'x'.repeat(MAX_ACTOR_MCP_RESPONSE_BYTES),
                        inputSchema: { type: 'object' },
                    },
                ],
            };
        if (path === '/mcp-large-pages') {
            const description = 'x'.repeat(MAX_ACTOR_MCP_RESPONSE_BYTES / 4);
            return { tools: [{ name: 'add', description, inputSchema: { type: 'object' } }], nextCursor: 'more' };
        }
        if (params?.cursor === undefined) return { tools: REMOTE_TOOL_PAGES[0], nextCursor: 'page-2' };
        if (params.cursor === 'page-2' && path === '/mcp') return { tools: REMOTE_TOOL_PAGES[1] };
        throw new McpError(ErrorCode.InvalidParams, `Invalid cursor ${params.cursor}`);
    });
    // Each HTTP request gets its own server, so the built-in handler has no request to cancel; record the notification.
    server.setNotificationHandler(CancelledNotificationSchema, ({ params }) => {
        remoteCancellations.push(String(params.reason));
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
    options: { signal?: AbortSignal; apifyClient?: ApifyClient } = {},
): Promise<ToolResult> {
    const context = stubToolCallContext(
        { actor: MCP_ACTOR, ...args },
        options.apifyClient ?? new ApifyClient({ token: TOKEN }),
    );
    if (options.signal) context.signal = options.signal;
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
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: path === '/mcp-large-json',
        });
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
    remoteCancellations = [];
});

describe('call-actor-mcp-tool', () => {
    it('returns the remote CallToolResult unchanged, with no run fields', async () => {
        const result = await dispatch(callActorMcpTool, { actor: MCP_ACTOR, tool: 'add', arguments: { a: 2, b: 3 } });

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

    it('rejects an MCP path that leaves the standby origin without connecting, and reports the Actor ID', async () => {
        seedActor('apify/off-origin-mcp-server', { definition: { webServerMcpPath: 'https://elsewhere.example/mcp' } });

        const result = await execute(executeCallActorMcpTool, { tool: 'add', actor: 'apify/off-origin-mcp-server' });

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain('resolves outside its standby origin');
        expect(result.toolTelemetry).toMatchObject({ actorId: 'off-origin-mcp-server-id' });
        expect(requestHeaders).toHaveLength(0);
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

    it('rejects an Actor that is not an MCP server without connecting, naming the tool that serves it', async () => {
        seedActor('apify/server-actor-test', { definition: { webServerMcpPath: undefined, hasWebServerSchema: true } });

        const result = await execute(executeCallActorMcpTool, { tool: 'add', actor: 'apify/server-actor-test' });

        expectSoftFailInvalidInput(result);
        expect((result.content as { text: string }[])[0].text).toBe(
            `Actor 'apify/server-actor-test' is not an MCP server. Its HTTP API can be called with ${HELPER_TOOLS.ACTOR_SERVER_REQUEST}.`,
        );
        expect(result.toolTelemetry).toMatchObject({ actorId: 'server-actor-test-id' });
        expect(requestHeaders).toHaveLength(0);
    });

    it("names the Actor's own server tool when the session has it", async () => {
        seedActor('apify/server-actor-test', { definition: { webServerMcpPath: undefined, hasWebServerSchema: true } });
        const context = stubToolCallContext(
            { actor: 'apify/server-actor-test', tool: 'add' },
            new ApifyClient({ token: TOKEN }),
            { loadedToolNames: ['apify--server-actor-test', HELPER_TOOLS.ACTOR_SERVER_REQUEST] },
        );

        const result = (await executeCallActorMcpTool(context)) as ToolResult;

        const { text } = (result.content as { text: string }[])[0];
        expect(text).toContain('called with apify--server-actor-test.');
        expect(text).not.toContain(HELPER_TOOLS.ACTOR_SERVER_REQUEST);
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

        const result = await execute(executeCallActorMcpTool, { tool: 'add', actor: 'apify/unreachable-mcp-server' });

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain('Failed to connect to MCP server');
    });

    it('reports a JSON-RPC error from the remote server as a failed call of that tool', async () => {
        const result = await execute(executeCallActorMcpTool, { tool: 'subtract' });

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain(`Failed to call MCP tool 'subtract' on Actor '${MCP_ACTOR}'`);
        // The server answered, so it is not unavailable.
        expect(JSON.stringify(result.content)).not.toContain('temporarily unavailable');
        expect(result.toolTelemetry).toMatchObject({
            toolStatus: TOOL_STATUS.SOFT_FAIL,
            failureCategory: FAILURE_CATEGORY.INVALID_INPUT,
        });
    });

    it.each([
        ['an event stream', '/mcp-large'],
        ['a JSON body', '/mcp-large-json'],
    ])('fails the call when the result in %s is over the byte limit', async (_label, webServerMcpPath) => {
        seedActor('apify/large-mcp-server', { definition: { webServerMcpPath } });

        const result = await execute(executeCallActorMcpTool, { tool: 'add', actor: 'apify/large-mcp-server' });

        expect(result.isError).toBe(true);
        expect(result).not.toHaveProperty('structuredContent');
        expect(JSON.stringify(result.content)).toContain(`${MAX_ACTOR_MCP_RESPONSE_BYTES}-byte limit`);
    });

    it('rejects a tool name longer than the MCP limit without connecting', async () => {
        await expect(
            execute(executeCallActorMcpTool, { tool: 'a'.repeat(MCP_TOOL_NAME_MAX_LENGTH + 1) }),
        ).rejects.toMatchObject({
            issues: [{ code: 'too_big', path: ['tool'], maximum: MCP_TOOL_NAME_MAX_LENGTH }],
        });
        expect(requestHeaders).toHaveLength(0);
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
        expect(withList).toContain('Connecting can start a Server Actor run');
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

    it('fails the listing when a page is over the byte limit, without a partial list', async () => {
        seedActor('apify/large-mcp-server', { definition: { webServerMcpPath: '/mcp-large' } });

        const result = await execute(executeFetchActorMcpToolList, { actor: 'apify/large-mcp-server' });

        expect(result.isError).toBe(true);
        expect(result).not.toHaveProperty('structuredContent');
        expect(JSON.stringify(result.content)).toContain(`${MAX_ACTOR_MCP_RESPONSE_BYTES}-byte limit`);
    });

    it('counts every page of the listing toward the byte limit', async () => {
        seedActor('apify/large-pages-mcp-server', { definition: { webServerMcpPath: '/mcp-large-pages' } });

        const result = await execute(executeFetchActorMcpToolList, { actor: 'apify/large-pages-mcp-server' });

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain(`${MAX_ACTOR_MCP_RESPONSE_BYTES}-byte limit`);
        expect(listCursors).toHaveLength(4);
    });

    it('gives the tools/list pages one external tool-call timeout and fails without partial results once it runs out', async () => {
        // Each page takes half the timeout, so the second gets the half that is left and ends at the deadline.
        let now = 0;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        const { request } = Client.prototype;
        const requestSpy = vi.spyOn(Client.prototype, 'request').mockImplementation(function (this: Client, ...args) {
            if (args[0].method === 'tools/list') now += EXTERNAL_TOOL_CALL_TIMEOUT_MSEC / 2;
            return request.apply(this, args);
        });

        const result = await execute(executeFetchActorMcpToolList, {});

        expect(result.isError).toBe(true);
        expect(result).not.toHaveProperty('structuredContent');
        const timeouts = requestSpy.mock.calls
            .filter(([{ method }]) => method === 'tools/list')
            .map(([, , options]) => options?.timeout);
        expect(timeouts).toEqual([EXTERNAL_TOOL_CALL_TIMEOUT_MSEC, EXTERNAL_TOOL_CALL_TIMEOUT_MSEC / 2]);
    });

    it('names call-actor-mcp-tool in the description only when the session has it, and states the billing caveat', () => {
        const withCall = fetchActorMcpToolList.buildDescription!(ALL_TOOLS_PRESENT);
        const withoutCall = fetchActorMcpToolList.buildDescription!(only(HELPER_TOOLS.ACTOR_MCP_TOOL_LIST));

        expect(fetchActorMcpToolList.description).toBe(withCall);
        expect(withCall).toContain(HELPER_TOOLS.ACTOR_MCP_TOOL_CALL);
        expect(withoutCall).not.toContain(HELPER_TOOLS.ACTOR_MCP_TOOL_CALL);
        expect(withCall).toContain('Connecting can start a Server Actor run');
    });
});

describe.each([
    { tool: callActorMcpTool, run: executeCallActorMcpTool, args: { tool: 'add' } },
    { tool: fetchActorMcpToolList, run: executeFetchActorMcpToolList, args: {} },
])('$tool.name before and during the connection', ({ tool, run, args }) => {
    it('returns the empty aborted response when the client cancels mid-request', async () => {
        seedActor('apify/slow-mcp-server', { definition: { webServerMcpPath: '/mcp-slow' } });
        const controller = new AbortController();

        const pending = execute(run, { ...args, actor: 'apify/slow-mcp-server' }, { signal: controller.signal });
        await vi.waitFor(() => expect(remoteCalls.length + listCursors.length).toBe(1));
        controller.abort();

        expect(await pending).toEqual({});
    });

    it('tells the remote server that a request which timed out is cancelled', async () => {
        seedActor('apify/slow-mcp-server', { definition: { webServerMcpPath: '/mcp-slow' } });
        const { request } = Client.prototype;
        vi.spyOn(Client.prototype, 'request').mockImplementation(function (this: Client, ...[req, schema, options]) {
            return request.call(this, req, schema, { ...options, timeout: 100 });
        });

        const result = await execute(run, { ...args, actor: 'apify/slow-mcp-server' });

        expect(result.isError).toBe(true);
        // A cancellation from the previous test may still arrive, so look for this one among them.
        await vi.waitFor(() =>
            expect(remoteCancellations).toContainEqual(expect.stringContaining('Request timed out')),
        );
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

/** A proxied tool for the `add` tool of the Actor's MCP server at `/mcp-large`, which can also run as a task. */
function makeLargeProxiedTool(): ToolEntry {
    return {
        type: TOOL_TYPE.ACTOR_MCP,
        name: 'apify--example-mcp-server--add',
        description: 'Adds two numbers.',
        inputSchema: { type: 'object', properties: {} },
        ajvValidate: compileSchema({ type: 'object', properties: {} }),
        originToolName: 'add',
        actorId: 'example-mcp-server-id',
        actorFullName: MCP_ACTOR,
        serverUrl: `${standbyUrl}/mcp-large`,
        execution: { taskSupport: 'optional' },
    } as ToolEntry;
}

/** Spies on the log levels a failure can take, keeping the test output quiet. */
function spyOnFailureLogs() {
    return {
        softFail: vi.spyOn(log, 'softFail').mockImplementation(() => undefined),
        exception: vi.spyOn(log, 'exception').mockImplementation(() => undefined),
        error: vi.spyOn(log, 'error').mockImplementation(() => undefined),
    };
}

function expectLoggedAsSoftFail(logs: ReturnType<typeof spyOnFailureLogs>): void {
    expect(logs.softFail).toHaveBeenCalled();
    expect(logs.exception).not.toHaveBeenCalled();
    expect(logs.error).not.toHaveBeenCalled();
}

describe('proxied Actor MCP tool', () => {
    it('fails the call when the remote result is over the byte limit', async () => {
        const result = await dispatch(makeLargeProxiedTool(), {});

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain(`${MAX_ACTOR_MCP_RESPONSE_BYTES}-byte limit`);
    });
});

describe('a response over the byte limit is a soft failure of the remote Actor', () => {
    it.each([
        { tool: callActorMcpTool, run: executeCallActorMcpTool, args: { tool: 'add' } },
        { tool: fetchActorMcpToolList, run: executeFetchActorMcpToolList, args: {} },
    ])('in $tool.name', async ({ run, args }) => {
        seedActor('apify/large-mcp-server', { definition: { webServerMcpPath: '/mcp-large' } });
        const logs = spyOnFailureLogs();

        const result = await execute(run, { ...args, actor: 'apify/large-mcp-server' });

        expect(result.toolTelemetry).toMatchObject({
            toolStatus: TOOL_STATUS.SOFT_FAIL,
            failureCategory: FAILURE_CATEGORY.INTERNAL_ERROR,
        });
        expectLoggedAsSoftFail(logs);
    });

    it.each([
        ['a call', {}],
        ['a task', { task: { ttl: 60_000 } }],
    ])('in a proxied tool run as %s', async (_label, taskParams) => {
        const trackSpy = vi.spyOn(telemetry, 'trackToolCall').mockImplementation(() => undefined);
        const logs = spyOnFailureLogs();
        const tool = makeLargeProxiedTool();

        await withServer(
            async (server) => {
                server.upsertTools([tool]);
                const response = await getRequestHandler(server, 'tools/call')(
                    {
                        method: 'tools/call',
                        params: { name: tool.name, arguments: {}, _meta: { mcpSessionId: 's1' }, ...taskParams },
                    },
                    { signal: new AbortController().signal, sendNotification: vi.fn() },
                );
                if ('task' in taskParams) {
                    const { taskId } = (response as { task: { taskId: string } }).task;
                    await vi.waitFor(async () =>
                        expect((await getTaskStore(server).getTask(taskId))?.status).toBe('completed'),
                    );
                }
                await vi.waitFor(() => expect(trackSpy).toHaveBeenCalledTimes(1));
            },
            // No token, so telemetry needs no user lookup.
            { token: undefined, telemetry: { enabled: true }, allowUnauthMode: true },
        );

        expect(trackSpy.mock.calls[0][2]).toMatchObject({
            tool_status: TOOL_STATUS.SOFT_FAIL,
            failure_category: FAILURE_CATEGORY.INTERNAL_ERROR,
        });
        expectLoggedAsSoftFail(logs);
    });

    it('in loading the tools of an MCP server Actor, which drops only that Actor', async () => {
        seedActor('apify/large-mcp-server', { definition: { webServerMcpPath: '/mcp-large' } });
        const { definition, info } = actorDefinitionCache.get('apify/large-mcp-server')!;
        const logs = spyOnFailureLogs();

        const tools = await getMCPServersAsTools([{ webServerMcpPath: '/mcp-large', definition, actor: info }], {
            token: TOKEN,
        });

        expect(tools).toEqual([]);
        expectLoggedAsSoftFail(logs);
    });
});

/**
 * A streamable HTTP MCP server written out by hand, for responses the SDK server does not send: it answers
 * `initialize`, accepts notifications, and hands each `tools/call` and GET to the given handler.
 */
async function withRawMcpServer(
    handlers: { onToolsCall: (res: ServerResponse, id: unknown) => void; onGet?: (res: ServerResponse) => void },
    run: (url: string) => Promise<void>,
): Promise<void> {
    const server = createServer((req, res) => {
        if (req.method === 'GET') {
            if (handlers.onGet) handlers.onGet(res);
            else res.writeHead(405).end();
            return;
        }
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
        });
        req.on('end', () => {
            const message = JSON.parse(body) as { id?: unknown; method: string };
            if (message.id === undefined) {
                res.writeHead(202).end();
                return;
            }
            if (message.method === 'tools/call') {
                handlers.onToolsCall(res, message.id);
                return;
            }
            const result = {
                protocolVersion: '2025-06-18',
                capabilities: { tools: {} },
                serverInfo: { name: 'example-mcp-server', version: '1.0.0' },
            };
            res.writeHead(200, { 'content-type': 'application/json' }).end(
                JSON.stringify({ jsonrpc: '2.0', id: message.id, result }),
            );
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}

async function callAddTool(url: string): Promise<void> {
    const client = await connectMCPClient(url, { token: TOKEN });
    try {
        await client?.callTool({ name: 'add', arguments: {} });
    } finally {
        await client?.close();
    }
}

describe('MCP response byte limit on the connection', () => {
    it('counts the bytes of a compressed body after decompression', async () => {
        await withRawMcpServer(
            {
                onToolsCall: (res, id) => {
                    const result = { content: [{ type: 'text', text: 'x'.repeat(MAX_ACTOR_MCP_RESPONSE_BYTES) }] };
                    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
                    res.end(gzipSync(JSON.stringify({ jsonrpc: '2.0', id, result })));
                },
            },
            async (url) => {
                await expect(callAddTool(url)).rejects.toThrow(`${MAX_ACTOR_MCP_RESPONSE_BYTES}-byte limit`);
            },
        );
    });

    it('counts the GET event stream toward the limit of a call in flight', async () => {
        await withRawMcpServer(
            {
                // The call is answered on an event stream that stays open and sends nothing.
                onToolsCall: (res) => {
                    res.writeHead(200, { 'content-type': 'text/event-stream' });
                },
                onGet: (res) => {
                    res.writeHead(200, { 'content-type': 'text/event-stream' });
                    res.write(`data: ${'x'.repeat(MAX_ACTOR_MCP_RESPONSE_BYTES)}`);
                },
            },
            async (url) => {
                await expect(callAddTool(url)).rejects.toThrow(`${MAX_ACTOR_MCP_RESPONSE_BYTES}-byte limit`);
            },
        );
    });

    it('fails the connection when the initialize result is over the limit, without the SSE fallback', async () => {
        await expect(connectMCPClient(`${standbyUrl}/mcp-large-init`, { token: TOKEN })).rejects.toThrow(
            `${MAX_ACTOR_MCP_RESPONSE_BYTES}-byte limit`,
        );
    });

    it('fails the SSE transport when its event stream passes the limit, and closes the stream', async () => {
        let isStreamClosed = false;
        let sendOnStream: ((chunk: string) => void) | undefined;
        const legacy = createServer((req, res) => {
            if (req.method === 'GET') {
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                res.on('close', () => {
                    isStreamClosed = true;
                });
                res.write('event: endpoint\ndata: /messages\n\n');
                sendOnStream = (chunk) => res.write(chunk);
                return;
            }
            if (req.url === '/messages') {
                res.writeHead(202).end();
                // The answer to initialize: one event that never ends.
                sendOnStream?.(`data: ${'x'.repeat(MAX_ACTOR_MCP_RESPONSE_BYTES)}`);
                return;
            }
            // Streamable HTTP is not served, so the client falls back to SSE.
            res.writeHead(404).end();
        });
        await new Promise<void>((resolve) => legacy.listen(0, '127.0.0.1', resolve));

        try {
            const url = `http://127.0.0.1:${(legacy.address() as AddressInfo).port}/mcp`;
            await expect(connectMCPClient(url, { token: TOKEN })).rejects.toThrow(
                `${MAX_ACTOR_MCP_RESPONSE_BYTES}-byte limit`,
            );
            await vi.waitFor(() => expect(isStreamClosed).toBe(true));
        } finally {
            legacy.closeAllConnections();
            await new Promise<void>((resolve) => legacy.close(() => resolve()));
        }
    });
});
