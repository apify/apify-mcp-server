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
    McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApifyClient, REQUEST_ORIGIN } from '../../src/apify_client.js';
import { APIFY_AI_CLIENT_NAME, FAILURE_CATEGORY, HELPER_TOOLS, TOOL_STATUS } from '../../src/const.js';
import { connectMCPClient } from '../../src/mcp/client.js';
import { EXTERNAL_TOOL_CALL_TIMEOUT_MSEC } from '../../src/mcp/const.js';
import { actorDefinitionCache } from '../../src/state.js';
import { callActorMcpTool, executeCallActorMcpTool } from '../../src/tools/actors/call_actor_mcp_tool.js';
import type { Actor, ActorDefinitionPruned, ToolTelemetryContext } from '../../src/types.js';
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

type ToolResult = Record<string, unknown> & { toolTelemetry?: ToolTelemetryContext };

/** Since the test started: the headers of every HTTP request to the remote server, and each tools/call it got. */
let requestHeaders: IncomingMessage['headers'][] = [];
let remoteCalls: { name: string; arguments: unknown }[] = [];
let httpServer: HttpServer;
let standbyUrl: string;

/** The Actor's MCP server: `wait` answers only once the call is cancelled, an unknown tool is a JSON-RPC error. */
function createRemoteServer(): Server {
    const server = new Server({ name: 'example-mcp-server', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
        remoteCalls.push({ name: params.name, arguments: params.arguments });
        if (params.name === 'wait') {
            await new Promise((resolve) => {
                extra.signal.addEventListener('abort', resolve);
            });
            return { content: [] };
        }
        const result = REMOTE_RESULTS[params.name];
        if (!result) throw new McpError(ErrorCode.InvalidParams, `Tool ${params.name} not found`);
        return result;
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

async function callTool(
    args: Record<string, unknown>,
    options: { signal?: AbortSignal; token?: string; apifyClient?: ApifyClient } = {},
): Promise<ToolResult> {
    const context = stubToolCallContext(
        { actor: MCP_ACTOR, tool: 'add', ...args },
        options.apifyClient ?? new ApifyClient({ token: TOKEN }),
    );
    if (options.signal) context.signal = options.signal;
    if (options.token !== undefined) context.apifyToken = options.token;
    return (await executeCallActorMcpTool(context)) as ToolResult;
}

async function dispatchTool(
    args: Record<string, unknown>,
    serverOptions: Parameters<typeof withServer>[1] = { token: TOKEN },
): Promise<Record<string, unknown>> {
    return withServer(async (server) => {
        server.upsertTools([callActorMcpTool]);
        return getRequestHandler(server, 'tools/call')(
            {
                method: 'tools/call',
                params: { name: HELPER_TOOLS.ACTOR_MCP_TOOL_CALL, arguments: args, _meta: { mcpSessionId: 's1' } },
            },
            { signal: new AbortController().signal, sendNotification: vi.fn() },
        );
    }, serverOptions);
}

beforeAll(async () => {
    httpServer = createServer((req, res) => {
        requestHeaders.push(req.headers);
        const remote = createRemoteServer();
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
});

describe('call-actor-mcp-tool', () => {
    it('returns the remote CallToolResult unchanged, with no run fields', async () => {
        const result = await dispatchTool({ actor: MCP_ACTOR, tool: 'add', arguments: { a: 2, b: 3 } });

        expect(result).toEqual(REMOTE_RESULTS.add);
        expect(remoteCalls).toEqual([{ name: 'add', arguments: { a: 2, b: 3 } }]);
    });

    it("passes the remote tool's error flag through, recorded as an internal error", async () => {
        const result = await callTool({ tool: 'fail' });

        expect(result).toMatchObject(REMOTE_RESULTS.fail);
        expect(result.toolTelemetry).toEqual({
            toolStatus: TOOL_STATUS.SOFT_FAIL,
            failureCategory: FAILURE_CATEGORY.INTERNAL_ERROR,
            actorId: 'example-mcp-server-id',
        });
    });

    it("ignores a toolTelemetry key in the remote result, so the remote cannot write the server's telemetry", async () => {
        const result = await callTool({ tool: 'spoof' });

        expect(result.toolTelemetry).toEqual({ actorId: 'example-mcp-server-id' });
    });

    it('rejects an MCP path that leaves the standby origin without connecting, and reports the Actor ID', async () => {
        seedActor('apify/off-origin-mcp-server', { definition: { webServerMcpPath: 'https://elsewhere.example/mcp' } });

        const result = await callTool({ actor: 'apify/off-origin-mcp-server' });

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain('resolves outside its standby origin');
        expect(result.toolTelemetry).toMatchObject({ actorId: 'off-origin-mcp-server-id' });
        expect(requestHeaders).toHaveLength(0);
    });

    it('sends omitted arguments as an empty object', async () => {
        await callTool({});

        expect(remoteCalls).toEqual([{ name: 'add', arguments: {} }]);
    });

    it('sends the session token and the MCP request origin on every request of the connection', async () => {
        await callTool({});

        expect(requestHeaders.length).toBeGreaterThan(0);
        for (const headers of requestHeaders) {
            expect(headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, 'x-apify-request-origin': 'MCP' });
        }
    });

    it('sends APIFY_AI as the request origin of the MCP connection for an Apify AI client session', async () => {
        await dispatchTool(
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

        await callTool({});

        expect(callToolSpy.mock.calls[0][2]).toMatchObject({ timeout: EXTERNAL_TOOL_CALL_TIMEOUT_MSEC });
    });

    it('rejects an Actor that is not an MCP server without connecting', async () => {
        seedActor('apify/server-actor-test', { definition: { webServerMcpPath: undefined, hasWebServerSchema: true } });

        const result = await callTool({ actor: 'apify/server-actor-test' });

        expectSoftFailInvalidInput(result);
        expect(result.toolTelemetry).toMatchObject({ actorId: 'server-actor-test-id' });
        expect(requestHeaders).toHaveLength(0);
    });

    it('returns the not-found response for an Actor the API does not know, without connecting', async () => {
        const unknownActorClient = Object.assign(
            new ApifyClient({ token: TOKEN }),
            mockApifyClient({ actor: () => ({ get: async () => undefined }) }),
        );

        const result = await callTool({ actor: 'apify/missing' }, { apifyClient: unknownActorClient });

        expectSoftFailInvalidInput(result);
        expect(requestHeaders).toHaveLength(0);
    });

    it('requires a token without connecting', async () => {
        const result = await dispatchTool({ actor: MCP_ACTOR, tool: 'add' }, { token: '', allowUnauthMode: true });

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

        const result = await callTool({ actor: 'apify/unreachable-mcp-server' });

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain('Failed to connect to MCP server');
    });

    it('reports a JSON-RPC error from the remote server as a failed call of that tool', async () => {
        const result = await callTool({ tool: 'subtract' });

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain(`Failed to call MCP tool 'subtract' on Actor '${MCP_ACTOR}'`);
    });

    it('returns the empty aborted response when the client cancels mid-call', async () => {
        const controller = new AbortController();
        const pending = callTool({ tool: 'wait' }, { signal: controller.signal });
        await vi.waitFor(() => expect(remoteCalls).toHaveLength(1));
        controller.abort();

        expect(await pending).toEqual({});
    });

    it('does not connect when the call is already cancelled', async () => {
        const controller = new AbortController();
        controller.abort();

        expect(await callTool({}, { signal: controller.signal })).toEqual({});
        expect(requestHeaders).toHaveLength(0);
    });

    it.each([
        ['with a token', { token: TOKEN }],
        ['without a token', { token: undefined }],
    ])('is rejected before connecting in a payment-provider session %s', async (_label, tokenOptions) => {
        const result = await dispatchTool(
            { actor: MCP_ACTOR, tool: 'add' },
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

        expect(await listActorsTools({})).toContain(HELPER_TOOLS.ACTOR_MCP_TOOL_CALL);
        expect(await listActorsTools({ paymentProvider: makePaymentProvider() })).not.toContain(
            HELPER_TOOLS.ACTOR_MCP_TOOL_CALL,
        );
    });

    it('names fetch-actor-details in the description only when the session has it, and states the billing caveat', () => {
        const withDetails = callActorMcpTool.buildDescription!(ALL_TOOLS_PRESENT);
        const withoutDetails = callActorMcpTool.buildDescription!(only(HELPER_TOOLS.ACTOR_MCP_TOOL_CALL));

        expect(callActorMcpTool.description).toBe(withDetails);
        expect(withDetails).toContain(HELPER_TOOLS.ACTOR_GET_DETAILS);
        expect(withoutDetails).not.toContain(HELPER_TOOLS.ACTOR_GET_DETAILS);
        expect(withDetails).toContain('Connecting can start a Server Actor run');
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
