import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
    CallToolRequestSchema,
    type CallToolResult,
    ErrorCode,
    ListToolsRequestSchema,
    McpError,
    type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApifyClient } from '../../src/apify_client.js';
import { FAILURE_CATEGORY, HELPER_TOOLS } from '../../src/const.js';
import { connectMCPClient } from '../../src/mcp/client.js';
import { EXTERNAL_TOOL_CALL_TIMEOUT_MSEC } from '../../src/mcp/const.js';
import { actorDefinitionCache } from '../../src/state.js';
import { callActorMcpTool, executeCallActorMcpTool } from '../../src/tools/actors/call_actor_mcp_tool.js';
import {
    executeFetchActorMcpToolList,
    fetchActorMcpToolList,
} from '../../src/tools/actors/fetch_actor_mcp_tool_list.js';
import type {
    Actor,
    ActorDefinitionPruned,
    HelperTool,
    InternalToolArgs,
    ToolTelemetryContext,
} from '../../src/types.js';
import { ALL_TOOLS_PRESENT } from '../../src/types.js';
import type { ToolResponse } from '../../src/utils/mcp.js';
import { mockActor } from './helpers/actor_build_client.js';
import { getRequestHandler, makePaymentProvider, withServer } from './helpers/mcp_server.js';
import { expectSoftFailInvalidInput, mockApifyClient, only, stubToolCallContext } from './helpers/tool_context.js';

const TOKEN = 'test-token';
const MCP_ACTOR = 'apify/example-mcp-server';

/** What the remote server returns per tool; `add` carries every field a `CallToolResult` can. */
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
};

/** The two pages of `tools/list` on `/mcp`; `add` carries every field a tool definition can. */
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
    [{ name: 'subtract', inputSchema: { type: 'object' } }],
];

type ToolResult = Record<string, unknown> & { toolTelemetry?: ToolTelemetryContext };

/** Since the test started: every HTTP request to the remote servers, and each tools/call and tools/list they got. */
let requests: { path?: string; headers: IncomingMessage['headers'] }[] = [];
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

type Execute = (toolArgs: InternalToolArgs) => Promise<ToolResponse>;

async function execute(
    run: Execute,
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
    tool: HelperTool,
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
        requests.push({ path, headers: req.headers });
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

beforeEach(() => {
    requests = [];
    remoteCalls = [];
    listCursors = [];
});

describe('call-actor-mcp-tool', () => {
    it('returns the remote CallToolResult unchanged, with no run fields', async () => {
        const result = await dispatch(callActorMcpTool as HelperTool, {
            actor: MCP_ACTOR,
            tool: 'add',
            arguments: { a: 2, b: 3 },
        });

        expect(result).toEqual(REMOTE_RESULTS.add);
        expect(remoteCalls).toEqual([{ name: 'add', arguments: { a: 2, b: 3 } }]);
    });

    it("passes the remote tool's error flag through and reports the Actor ID", async () => {
        const result = await execute(executeCallActorMcpTool, { tool: 'fail' });

        expect(result).toMatchObject(REMOTE_RESULTS.fail);
        expect(result.toolTelemetry).toEqual({ actorId: 'example-mcp-server-id' });
    });

    it('sends omitted arguments as an empty object', async () => {
        await execute(executeCallActorMcpTool, { tool: 'add' });

        expect(remoteCalls).toEqual([{ name: 'add', arguments: {} }]);
    });

    it('sends the session token and the MCP request origin on every request of the connection', async () => {
        await execute(executeCallActorMcpTool, { tool: 'add' });

        expect(requests.length).toBeGreaterThan(0);
        for (const { headers } of requests) {
            expect(headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, 'x-apify-request-origin': 'MCP' });
        }
    });

    it('passes the external tool-call timeout and the call signal to tools/call', async () => {
        const callToolSpy = vi.spyOn(Client.prototype, 'callTool');
        const controller = new AbortController();

        await execute(executeCallActorMcpTool, { tool: 'add' }, { signal: controller.signal });

        expect(callToolSpy.mock.calls[0][2]).toMatchObject({
            timeout: EXTERNAL_TOOL_CALL_TIMEOUT_MSEC,
            signal: controller.signal,
        });
        callToolSpy.mockRestore();
    });

    it('reports a JSON-RPC error from the remote server as a failed call of that tool', async () => {
        const result = await execute(executeCallActorMcpTool, { tool: 'subtract' });

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain(`Failed to call MCP tool 'subtract' on Actor '${MCP_ACTOR}'`);
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
    it("returns every page's tool definitions unchanged, with one line of text per tool", async () => {
        const result = await dispatch(fetchActorMcpToolList as HelperTool, { actor: MCP_ACTOR });

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
        expect(JSON.stringify(result.content)).toContain('more than 100 pages');
    });

    it('passes the external tool-call timeout and the call signal to every tools/list page', async () => {
        const listToolsSpy = vi.spyOn(Client.prototype, 'listTools');
        const controller = new AbortController();

        await execute(executeFetchActorMcpToolList, {}, { signal: controller.signal });

        expect(listToolsSpy).toHaveBeenCalledTimes(2);
        for (const [, options] of listToolsSpy.mock.calls) {
            expect(options).toMatchObject({ timeout: EXTERNAL_TOOL_CALL_TIMEOUT_MSEC, signal: controller.signal });
        }
        listToolsSpy.mockRestore();
    });

    it("discovers again on every call, under each caller's token", async () => {
        await execute(executeFetchActorMcpToolList, {}, { token: 'first-token' });
        await execute(executeFetchActorMcpToolList, {}, { token: 'second-token' });

        expect(listCursors).toEqual([undefined, 'page-2', undefined, 'page-2']);
        const tokens = new Set(requests.map(({ headers }) => headers.authorization));
        expect(tokens).toEqual(new Set(['Bearer first-token', 'Bearer second-token']));
    });

    it('closes the client after a listing that succeeds and after one that fails', async () => {
        seedActor('apify/broken-pages-mcp-server', { definition: { webServerMcpPath: '/mcp-broken-pages' } });
        const closeSpy = vi.spyOn(Client.prototype, 'close');

        await execute(executeFetchActorMcpToolList, {});
        await execute(executeFetchActorMcpToolList, { actor: 'apify/broken-pages-mcp-server' });

        expect(closeSpy).toHaveBeenCalledTimes(2);
        closeSpy.mockRestore();
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
    { tool: callActorMcpTool as HelperTool, run: executeCallActorMcpTool, args: { tool: 'add' } },
    { tool: fetchActorMcpToolList as HelperTool, run: executeFetchActorMcpToolList, args: {} },
])('$tool.name before and during the connection', ({ tool, run, args }) => {
    it('rejects an Actor that is not an MCP server without connecting', async () => {
        seedActor('apify/server-actor-test', { definition: { webServerMcpPath: undefined, hasWebServerSchema: true } });

        const result = await execute(run, { ...args, actor: 'apify/server-actor-test' });

        expectSoftFailInvalidInput(result);
        expect(result.toolTelemetry).toMatchObject({ actorId: 'server-actor-test-id' });
        expect(requests).toHaveLength(0);
    });

    it('returns the not-found response for an Actor the API does not know, without connecting', async () => {
        const unknownActorClient = Object.assign(
            new ApifyClient({ token: TOKEN }),
            mockApifyClient({ actor: () => ({ get: async () => undefined }) }),
        );

        const result = await execute(run, { ...args, actor: 'apify/missing' }, { apifyClient: unknownActorClient });

        expectSoftFailInvalidInput(result);
        expect(requests).toHaveLength(0);
    });

    it('requires a token without connecting', async () => {
        const result = await execute(run, args, { token: '' });

        expect(result.toolTelemetry).toMatchObject({ failureCategory: FAILURE_CATEGORY.AUTH });
        expect(requests).toHaveLength(0);
    });

    it('reports a server that cannot be reached as a connection failure', async () => {
        const closed = createServer();
        await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
        const { port } = closed.address() as AddressInfo;
        await new Promise<void>((resolve) => closed.close(() => resolve()));
        seedActor('apify/unreachable-mcp-server', { actor: { standbyUrl: `http://127.0.0.1:${port}` } });

        const result = await execute(run, { ...args, actor: 'apify/unreachable-mcp-server' });

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain('Failed to connect to MCP server');
    });

    it('returns the empty aborted response when the client cancels mid-request', async () => {
        seedActor('apify/slow-mcp-server', { definition: { webServerMcpPath: '/mcp-slow' } });
        const controller = new AbortController();

        const pending = execute(run, { ...args, actor: 'apify/slow-mcp-server' }, { signal: controller.signal });
        await vi.waitFor(() => expect(remoteCalls.length + listCursors.length).toBe(1));
        controller.abort();

        expect(await pending).toEqual({});
    });

    it('does not connect when the call is already cancelled', async () => {
        const controller = new AbortController();
        controller.abort();

        expect(await execute(run, args, { signal: controller.signal })).toEqual({});
        expect(requests).toHaveLength(0);
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
        expect(requests).toHaveLength(0);
    });
});

describe('MCP connection headers', () => {
    it('sends the token and the MCP request origin on the SSE fallback too', async () => {
        const seen: { method?: string; headers: IncomingMessage['headers'] }[] = [];
        const notFound = createServer((req, res) => {
            seen.push({ method: req.method, headers: req.headers });
            res.writeHead(404).end();
        });
        await new Promise<void>((resolve) => notFound.listen(0, '127.0.0.1', resolve));

        const client = await connectMCPClient(
            `http://127.0.0.1:${(notFound.address() as AddressInfo).port}/mcp`,
            TOKEN,
        );
        await new Promise<void>((resolve) => notFound.close(() => resolve()));

        expect(client).toBeNull();
        expect(seen.map(({ method }) => method)).toEqual(['POST', 'GET']);
        for (const { headers } of seen) {
            expect(headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, 'x-apify-request-origin': 'MCP' });
        }
    });
});
