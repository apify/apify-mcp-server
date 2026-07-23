import type { JSONRPCMessage, ServerContext } from '@modelcontextprotocol/server';
import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    InMemoryTransport,
    PROTOCOL_VERSION_META_KEY,
    ProtocolError,
} from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';

import log from '@apify/log';

import type * as ApifyClientModule from '../../src/apify_client.js';
import { APIFY_AI_CLIENT_NAME, HELPER_TOOLS, TOOL_STATUS } from '../../src/const.js';
import * as mcpClient from '../../src/mcp/client.js';
import { createServer2 } from '../../src/mcp/server2.js';
import { prepareTelemetryData } from '../../src/mcp/tool_call_telemetry.js';
import { RESOURCE_MIME_TYPE } from '../../src/resources/widgets.js';
import { actorExecutor } from '../../src/tools/actors/actor_executor.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../src/types.js';
import { SERVER_MODE, TOOL_TYPE } from '../../src/types.js';
import { compileSchema } from '../../src/utils/ajv.js';
import { respondRaw } from '../../src/utils/mcp.js';
import {
    getRequestHandler,
    makeActorMcpTool,
    makePaymentRequiredError,
    makePermissionApprovalError,
    makeThrowingTool,
    withServer,
    X402_PAYMENT_DATA,
} from './helpers/mcp_server.js';

const MODERN_PROTOCOL_VERSION = '2026-07-28';

// Capture ApifyClient constructor options so a test can assert the request-origin the tool-call
// path tagged onto the outbound Apify client (the same seam as mcp.server.resource_request_origin).
const { capturedClientOptions } = vi.hoisted(() => ({ capturedClientOptions: [] as Record<string, unknown>[] }));

vi.mock('../../src/apify_client.js', async (importOriginal) => {
    const actual = await importOriginal<typeof ApifyClientModule>();
    return {
        ...actual,
        ApifyClient: class {
            constructor(options: Record<string, unknown>) {
                capturedClientOptions.push(options);
            }
        },
    };
});

type Server2HandlerFn = (req: Record<string, unknown>, ctx: ServerContext) => Promise<Record<string, unknown>>;

/**
 * Returns the request handler the v2 SDK registered for `method`, reached through the modern
 * server's private `_requestHandlers` map (the modern server IS the protocol instance — no
 * `.server` hop, unlike the v1 seam in {@link getRequestHandler}).
 */
function getServer2RequestHandler(server2: unknown, method: string): Server2HandlerFn {
    // eslint-disable-next-line no-underscore-dangle
    const handler = (server2 as { _requestHandlers: Map<string, Server2HandlerFn> })._requestHandlers.get(method);
    if (!handler) throw new Error(`Handler "${method}" not registered`);
    return handler;
}

function listServer2HandlerMethods(server2: unknown): string[] {
    // eslint-disable-next-line no-underscore-dangle
    return Array.from((server2 as { _requestHandlers: Map<string, Server2HandlerFn> })._requestHandlers.keys());
}

/**
 * Fabricated per-request v2 handler context: the envelope carries the reserved
 * `io.modelcontextprotocol/*` keys exactly as the SDK's lift surfaces them, and `authInfo`
 * stands in for the hosting layer's validated-token pass-through.
 */
function makeServer2Ctx(
    options: {
        clientInfo?: { name: string; version: string };
        capabilities?: Record<string, unknown>;
        authToken?: string;
        sessionId?: string;
    } = {},
): ServerContext {
    const { clientInfo, capabilities, authToken, sessionId } = options;
    const envelope: Record<string, unknown> = { [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION };
    if (clientInfo) envelope[CLIENT_INFO_META_KEY] = clientInfo;
    if (capabilities) envelope[CLIENT_CAPABILITIES_META_KEY] = capabilities;
    return {
        sessionId,
        mcpReq: {
            id: 1,
            method: 'tools/call',
            envelope,
            signal: new AbortController().signal,
            notify: vi.fn(async () => {}),
            requestState: () => undefined,
        },
        ...(authToken ? { http: { authInfo: { token: authToken, clientId: 'c1', scopes: [] } } } : {}),
    } as unknown as ServerContext;
}

/** An INTERNAL tool that echoes the Apify token the engine resolved for the call. */
function makeTokenEchoTool(name = 'token-echo-tool'): ToolEntry {
    return {
        type: TOOL_TYPE.INTERNAL,
        name,
        description: 'echoes the resolved apify token',
        inputSchema: { type: 'object', properties: {}, additionalProperties: true },
        ajvValidate: Object.assign(() => true, { errors: null }) as unknown as ToolEntry['ajvValidate'],
        annotations: {},
        call: async (toolArgs: InternalToolArgs) => {
            return respondRaw({ content: [{ type: 'text', text: String(toolArgs.apifyToken) }] });
        },
    } as ToolEntry;
}

/**
 * An INTERNAL tool whose `ajvValidate` throws, so `prepareToolCall` catches it and returns a
 * `PreparedCallError` (`'result' in prepared`) — the engine-classified prepare-failure branch.
 */
function makeAjvThrowingTool(name = 'ajv-throwing-tool'): ToolEntry {
    return {
        type: TOOL_TYPE.INTERNAL,
        name,
        description: 'ajvValidate throws',
        inputSchema: { type: 'object', properties: {}, additionalProperties: true },
        ajvValidate: Object.assign(
            () => {
                throw new Error('ajv exploded');
            },
            { errors: null },
        ) as unknown as ToolEntry['ajvValidate'],
        annotations: {},
        call: async () => respondRaw({ content: [{ type: 'text', text: 'unreached' }] }),
    } as ToolEntry;
}

/**
 * A tool with a type outside the closed `TOOL_TYPE` union, so `dispatchToolCall`'s exhaustiveness
 * guard throws a v1 `McpError` — the engine's protocol-error escape hatch that must surface as a
 * protocol error, not a classified isError result.
 */
function makeUnknownTypeTool(name = 'unknown-type-tool'): ToolEntry {
    return {
        type: 'BOGUS_TYPE' as unknown as ToolEntry['type'],
        name,
        description: 'has an unknown tool type',
        inputSchema: { type: 'object', properties: {}, additionalProperties: true },
        ajvValidate: Object.assign(() => true, { errors: null }) as unknown as ToolEntry['ajvValidate'],
        annotations: {},
        call: async () => respondRaw({ content: [{ type: 'text', text: 'unreached' }] }),
    } as ToolEntry;
}

/** A minimal ACTOR tool; its executor is spied so the call runs network-free (see tool-type parity). */
function makeActorTool(name = 'test-actor-tool'): ToolEntry {
    return {
        type: TOOL_TYPE.ACTOR,
        name,
        description: 'actor',
        inputSchema: { type: 'object', properties: {} } as ToolInputSchema,
        ajvValidate: compileSchema({ type: 'object', properties: {} }),
        actorId: 'test/actor',
        actorFullName: 'test/actor',
    } as ToolEntry;
}

function callTool(handler: Server2HandlerFn, name: string, ctx: ServerContext, args: Record<string, unknown> = {}) {
    return handler({ method: 'tools/call', params: { name, arguments: args } }, ctx);
}

describe('createServer2()', () => {
    describe('registration surface', () => {
        it('registers the modern surfaces and no tasks handlers', async () => {
            await withServer(async (server) => {
                const modern = createServer2(server);
                const methods = listServer2HandlerMethods(modern);
                for (const method of [
                    'tools/list',
                    'tools/call',
                    'resources/list',
                    'resources/read',
                    'resources/templates/list',
                    'prompts/list',
                    'prompts/get',
                ]) {
                    expect(methods).toContain(method);
                }
                expect(methods.filter((m) => m.startsWith('tasks/'))).toEqual([]);
            });
        });

        it('constructs a usable server without throwing', async () => {
            await withServer(async (server) => {
                expect(() => createServer2(server)).not.toThrow();
            });
        });
    });

    describe('tasks/* rejection', () => {
        it('rejects a tasks/* request with JSON-RPC -32601 through the SDK dispatch', async () => {
            // Criterion 20: drive an actual tasks/get request through the constructed v2 Server's real
            // message dispatch (its _onrequest, over a linked in-memory transport) — not a
            // _requestHandlers lookup — and observe the -32601 error response. createServer2 registers
            // no tasks/* handler, so the SDK's own dispatch falls through to its MethodNotFound path.
            // The v1 ActorsMcpServer still serves tasks/*; this rejection is specific to the stateless
            // modern surface.
            await withServer(async (server) => {
                const modern = createServer2(server);
                const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
                const responses: { id?: number | string; error?: { code?: number } }[] = [];
                clientTransport.onmessage = (message: JSONRPCMessage) => {
                    responses.push(message as { id?: number | string; error?: { code?: number } });
                };
                await clientTransport.start();
                await modern.connect(serverTransport);

                const tasksRequest = {
                    jsonrpc: '2.0' as const,
                    id: 42,
                    method: 'tasks/get',
                    params: { taskId: 'nonexistent' },
                };
                await clientTransport.send(tasksRequest);
                await modern.close();

                const response = responses.find((r) => r.id === 42);
                expect(response?.error?.code).toBe(-32601);
            });
        });
    });

    describe('tools/list', () => {
        it('lists the tools of the backing ActorsMcpServer', async () => {
            await withServer(async (server) => {
                server.upsertTools([makeTokenEchoTool()]);
                const modern = createServer2(server);
                const result = await getServer2RequestHandler(modern, 'tools/list')(
                    { method: 'tools/list', params: {} },
                    makeServer2Ctx(),
                );
                const names = (result.tools as { name: string }[]).map((t) => t.name);
                expect(names).toContain('token-echo-tool');
            });
        });

        it('admits report-problem via the real load path only for a servable request', async () => {
            await withServer(
                async (server) => {
                    // Real deployment load path (NOT upsertTools force-insertion): report-problem carries
                    // no actor name, so getActors short-circuits (no network) and it lands in the
                    // client-gated pending queue — withheld from this.tools until the client is known.
                    await server.loadToolsByName([HELPER_TOOLS.PROBLEM_REPORT], {} as never);
                    expect(server.tools.has(HELPER_TOOLS.PROBLEM_REPORT)).toBe(false);

                    // createServer2's eager compose admits it into the candidate set (v1's initialize
                    // flush never runs on the stateless path); tools/list then gates it per request.
                    const modern = createServer2(server);
                    expect(server.tools.has(HELPER_TOOLS.PROBLEM_REPORT)).toBe(true);
                    // Telemetry on + composed => the construction-time instructions advertise it.
                    // eslint-disable-next-line no-underscore-dangle
                    expect((modern as unknown as { _instructions?: string })._instructions).toContain(
                        HELPER_TOOLS.PROBLEM_REPORT,
                    );
                    const handler = getServer2RequestHandler(modern, 'tools/list');

                    const servable = await handler(
                        { method: 'tools/list', params: {} },
                        makeServer2Ctx({ clientInfo: { name: 'test-client', version: '1.0.0' } }),
                    );
                    expect((servable.tools as { name: string }[]).map((t) => t.name)).toContain(
                        HELPER_TOOLS.PROBLEM_REPORT,
                    );

                    // No clientInfo => client unknown for this request => not servable => withheld.
                    const notServable = await handler({ method: 'tools/list', params: {} }, makeServer2Ctx());
                    expect((notServable.tools as { name: string }[]).map((t) => t.name)).not.toContain(
                        HELPER_TOOLS.PROBLEM_REPORT,
                    );

                    // report-problem is the frozen registry singleton here; clear before withServer's
                    // close() so it doesn't try to null the frozen tool's ajvValidate (mirrors the v1
                    // report-problem gating suite's teardown).
                    server.tools.clear();
                },
                { telemetry: { enabled: true } },
            );
        });

        it('withholds report-problem and does not advertise it in instructions when telemetry is off', async () => {
            // Default withServer telemetry is OFF. report-problem forwards only via telemetry, so the
            // eager compose must keep it out of this.tools (client-independent gate), and the
            // construction-time instructions must not tell a client to call a tool tools/list withholds.
            await withServer(async (server) => {
                expect(server.telemetryEnabled).toBe(false);
                await server.loadToolsByName([HELPER_TOOLS.PROBLEM_REPORT], {} as never);
                expect(server.tools.has(HELPER_TOOLS.PROBLEM_REPORT)).toBe(false);

                const modern = createServer2(server);
                // Not composed when telemetry is off — no false advertisement downstream.
                expect(server.tools.has(HELPER_TOOLS.PROBLEM_REPORT)).toBe(false);
                // eslint-disable-next-line no-underscore-dangle
                expect((modern as unknown as { _instructions?: string })._instructions).not.toContain(
                    HELPER_TOOLS.PROBLEM_REPORT,
                );

                // Even a servable-looking request (clientInfo present) cannot surface it: telemetry
                // off => isReportProblemServableForClient is false and it was never composed anyway.
                const notServable = await getServer2RequestHandler(modern, 'tools/list')(
                    { method: 'tools/list', params: {} },
                    makeServer2Ctx({ clientInfo: { name: 'test-client', version: '1.0.0' } }),
                );
                expect((notServable.tools as { name: string }[]).map((t) => t.name)).not.toContain(
                    HELPER_TOOLS.PROBLEM_REPORT,
                );

                server.tools.clear();
            });
        });
    });

    describe('tools/call token resolution', () => {
        it('resolves the Apify token from ctx.http.authInfo.token over the instance option', async () => {
            await withServer(async (server) => {
                server.upsertTools([makeTokenEchoTool()]);
                const handler = getServer2RequestHandler(createServer2(server), 'tools/call');
                const result = await callTool(
                    handler,
                    'token-echo-tool',
                    makeServer2Ctx({ authToken: 'auth-info-token' }),
                );
                const content = result.content as { type: string; text: string }[];
                expect(content[0].text).toBe('auth-info-token');
            });
        });

        it('falls back to the instance token when the request carries no authInfo', async () => {
            await withServer(async (server) => {
                server.upsertTools([makeTokenEchoTool()]);
                const handler = getServer2RequestHandler(createServer2(server), 'tools/call');
                const result = await callTool(handler, 'token-echo-tool', makeServer2Ctx());
                const content = result.content as { type: string; text: string }[];
                expect(content[0].text).toBe('fake-token');
            });
        });
    });

    describe('tools/call invalid-call rejections', () => {
        it('rejects an unknown tool with an InvalidParams protocol error', async () => {
            await withServer(async (server) => {
                const handler = getServer2RequestHandler(createServer2(server), 'tools/call');
                await expect(callTool(handler, 'no-such-tool', makeServer2Ctx())).rejects.toThrow(ProtocolError);
            });
        });

        it('rejects when no token is resolvable and unauthenticated mode is off', async () => {
            await withServer(
                async (server) => {
                    server.upsertTools([makeTokenEchoTool()]);
                    const handler = getServer2RequestHandler(createServer2(server), 'tools/call');
                    await expect(callTool(handler, 'token-echo-tool', makeServer2Ctx())).rejects.toThrow(
                        /Apify API token is required/,
                    );
                },
                { token: undefined },
            );
        });

        it('never invokes the v1 sendLoggingMessage side-channel on the modern path', async () => {
            await withServer(async (server) => {
                const sendLogSpy = vi.spyOn(server.server, 'sendLoggingMessage').mockResolvedValue(undefined);
                const handler = getServer2RequestHandler(createServer2(server), 'tools/call');
                await expect(callTool(handler, 'no-such-tool', makeServer2Ctx())).rejects.toThrow(ProtocolError);
                expect(sendLogSpy).not.toHaveBeenCalled();
            });
        });
    });

    describe('tools/call result projection', () => {
        it('projects a successful result through projectCallToolResult with the tool output schema', async () => {
            await withServer(async (server) => {
                const tool = makeTokenEchoTool();
                tool.outputSchema = { type: 'object' } as ToolEntry['outputSchema'];
                server.upsertTools([tool]);
                const modern = createServer2(server);
                const projectSpy = vi.spyOn(modern, 'projectCallToolResult');
                const handler = getServer2RequestHandler(modern, 'tools/call');
                await callTool(handler, 'token-echo-tool', makeServer2Ctx());
                expect(projectSpy).toHaveBeenCalledTimes(1);
                expect(projectSpy.mock.calls[0][1]).toEqual({ type: 'object' });
            });
        });

        it('projects an engine-classified prepare failure (PreparedCallError) with no output schema', async () => {
            await withServer(async (server) => {
                server.upsertTools([makeAjvThrowingTool()]);
                const modern = createServer2(server);
                const projectSpy = vi.spyOn(modern, 'projectCallToolResult');
                const handler = getServer2RequestHandler(modern, 'tools/call');
                const result = await callTool(handler, 'ajv-throwing-tool', makeServer2Ctx());
                // The '\'result\' in prepared' branch: classified isError result, projected with
                // undefined schema — a returned result, not a thrown protocol error.
                expect(result.isError).toBe(true);
                expect(projectSpy).toHaveBeenCalledTimes(1);
                expect((projectSpy.mock.calls[0][0] as { isError?: boolean }).isError).toBe(true);
                expect(projectSpy.mock.calls[0][1]).toBeUndefined();
            });
        });
    });

    describe('tools/call escaped McpError', () => {
        it('surfaces the engine escape-hatch McpError as a protocol error, not a classified result', async () => {
            await withServer(async (server) => {
                server.upsertTools([makeUnknownTypeTool()]);
                const modern = createServer2(server);
                const projectSpy = vi.spyOn(modern, 'projectCallToolResult');
                const handler = getServer2RequestHandler(modern, 'tools/call');
                // dispatchToolCall's exhaustiveness guard throws a v1 McpError that escapes the engine;
                // server2's catch must re-throw it as a protocol error, not reclassify it to isError.
                await expect(callTool(handler, 'unknown-type-tool', makeServer2Ctx())).rejects.toThrow(ProtocolError);
                expect(projectSpy).not.toHaveBeenCalled();
            });
        });
    });

    describe('tools/call error-kind parity with v1', () => {
        // Criteria 18/19: a genuine tool-execution failure of each error class must project to the
        // same wire shape as the v1 CallToolRequestSchema handler for the same input. Both shells run
        // the identical classifyToolCallError; the modern shell additionally passes the outcome result
        // through projectCallToolResult (identity for these results — no output schema, and no
        // non-object structuredContent). Reuses the v1 fixtures, no parallel error shapes invented.
        const cases: { label: string; makeError: () => unknown }[] = [
            { label: 'payment-required (402)', makeError: () => makePaymentRequiredError(X402_PAYMENT_DATA) },
            { label: 'permission-approval', makeError: makePermissionApprovalError },
            { label: 'generic execution error', makeError: () => new Error('boom') },
        ];

        for (const { label, makeError } of cases) {
            it(`projects a ${label} failure to the same wire shape as v1`, async () => {
                await withServer(async (server) => {
                    // Silence the error-path logging classifyToolCallError emits (logHttpError).
                    vi.spyOn(log, 'error').mockImplementation(() => log);
                    vi.spyOn(log, 'exception').mockImplementation(() => log);
                    server.upsertTools([makeThrowingTool({ error: makeError() })]);

                    // v1 path: identity-projected outcome.result.
                    const v1Result = await getRequestHandler(server, 'tools/call')(
                        {
                            method: 'tools/call',
                            params: { name: 'test-throwing-tool', arguments: {}, _meta: { mcpSessionId: 's1' } },
                        },
                        { signal: { aborted: false }, sendNotification: vi.fn() },
                    );

                    // Modern path: same engine classification, then projectCallToolResult.
                    const modernResult = await callTool(
                        getServer2RequestHandler(createServer2(server), 'tools/call'),
                        'test-throwing-tool',
                        makeServer2Ctx(),
                    );

                    expect(modernResult.isError).toBe(true);
                    expect(modernResult).toEqual(v1Result);
                    vi.restoreAllMocks();
                });
            });
        }

        it('carries the x402 payment payload and FAILED execution telemetry through the modern projection', async () => {
            // Pin the two class-specific wire details the deep-equal above rides on, so a projection
            // regression that silently drops them is caught explicitly.
            await withServer(async (server) => {
                vi.spyOn(log, 'error').mockImplementation(() => log);
                vi.spyOn(log, 'exception').mockImplementation(() => log);
                const handler = getServer2RequestHandler(createServer2(server), 'tools/call');

                server.upsertTools([
                    makeThrowingTool({ name: 'pay-tool', error: makePaymentRequiredError(X402_PAYMENT_DATA) }),
                ]);
                const payResult = await callTool(handler, 'pay-tool', makeServer2Ctx());
                expect(payResult.isError).toBe(true);
                expect(payResult.structuredContent).toEqual(X402_PAYMENT_DATA);

                server.upsertTools([makeThrowingTool({ name: 'exec-tool', error: new Error('boom') })]);
                const execResult = await callTool(handler, 'exec-tool', makeServer2Ctx());
                expect(execResult.isError).toBe(true);
                expect(execResult.toolTelemetry).toEqual({ toolStatus: TOOL_STATUS.FAILED });
                expect((execResult.content as { text: string }[])[0].text).toContain('boom');
                vi.restoreAllMocks();
            });
        });
    });

    describe('tools/call tool-type parity with v1', () => {
        // Criterion 15: the same tool + args driven through the v1 CallToolRequestSchema handler and
        // the modern tools/call handler must produce the same result shape. The INTERNAL leg is
        // covered by the error-kind parity loop and the token-echo tests above; this block adds the
        // ACTOR and ACTOR_MCP legs. Both shells run the shared prepareToolCall/executeSyncToolCall
        // engine; the modern shell adds projectCallToolResult, identity here (no output schema, and
        // object/absent structuredContent). The two dispatch seams are stubbed (executeActorTool,
        // connectMCPClient), so no APIFY_TOKEN or real Actor run is needed.

        it('projects an ACTOR success to the same result shape as v1', async () => {
            await withServer(async (server) => {
                vi.spyOn(actorExecutor, 'executeActorTool').mockImplementation(async () => ({
                    content: [{ type: 'text', text: 'actor ok' }],
                }));
                server.upsertTools([makeActorTool()]);

                const v1Result = await getRequestHandler(server, 'tools/call')(
                    {
                        method: 'tools/call',
                        params: { name: 'test-actor-tool', arguments: {}, _meta: { mcpSessionId: 's1' } },
                    },
                    { signal: { aborted: false }, sendNotification: vi.fn() },
                );
                const modernResult = await callTool(
                    getServer2RequestHandler(createServer2(server), 'tools/call'),
                    'test-actor-tool',
                    makeServer2Ctx(),
                );

                expect(modernResult).toEqual({ content: [{ type: 'text', text: 'actor ok' }] });
                expect(modernResult).toEqual(v1Result);
                vi.restoreAllMocks();
            });
        });

        it('projects an ACTOR_MCP connect failure to the same soft-fail result shape as v1', async () => {
            await withServer(async (server) => {
                vi.spyOn(log, 'softFail').mockImplementation(() => log);
                // connectMCPClient -> null is the network-free connect-failure branch: dispatch returns
                // an isError soft-fail result (no throw), exercised identically by both shells.
                vi.spyOn(mcpClient, 'connectMCPClient').mockResolvedValue(null);
                server.upsertTools([makeActorMcpTool()]);

                const v1Result = await getRequestHandler(server, 'tools/call')(
                    {
                        method: 'tools/call',
                        params: { name: 'test-actor-mcp-tool', arguments: {}, _meta: { mcpSessionId: 's1' } },
                    },
                    { signal: { aborted: false }, sendNotification: vi.fn() },
                );
                const modernResult = await callTool(
                    getServer2RequestHandler(createServer2(server), 'tools/call'),
                    'test-actor-mcp-tool',
                    makeServer2Ctx(),
                );

                expect(modernResult.isError).toBe(true);
                expect((modernResult.content as { text: string }[])[0].text).toContain(
                    'Failed to connect to MCP server',
                );
                expect(modernResult).toEqual(v1Result);
                vi.restoreAllMocks();
            });
        });
    });

    describe('tools/call request-origin attribution', () => {
        it('attributes APIFY_AI when the envelope client identity is the Apify AI client', async () => {
            await withServer(async (server) => {
                capturedClientOptions.length = 0;
                server.upsertTools([makeTokenEchoTool()]);
                const handler = getServer2RequestHandler(createServer2(server), 'tools/call');
                await callTool(
                    handler,
                    'token-echo-tool',
                    makeServer2Ctx({ clientInfo: { name: APIFY_AI_CLIENT_NAME, version: '1.0.0' } }),
                );
                expect(capturedClientOptions.at(-1)).toMatchObject({ requestOrigin: 'APIFY_AI' });
            });
        });

        it('falls back to MCP when the envelope client identity is absent or unknown', async () => {
            await withServer(async (server) => {
                capturedClientOptions.length = 0;
                server.upsertTools([makeTokenEchoTool()]);
                const handler = getServer2RequestHandler(createServer2(server), 'tools/call');
                // Unknown client on one request, no clientInfo on the next — both attribute MCP,
                // and the APIFY_AI branch above proves the value is not hardcoded.
                await callTool(
                    handler,
                    'token-echo-tool',
                    makeServer2Ctx({ clientInfo: { name: 'some-other-client', version: '1.0.0' } }),
                );
                expect(capturedClientOptions.at(-1)).toMatchObject({ requestOrigin: 'MCP' });
                await callTool(handler, 'token-echo-tool', makeServer2Ctx());
                expect(capturedClientOptions.at(-1)).toMatchObject({ requestOrigin: 'MCP' });
            });
        });

        it('derives identity per request on the same server instance (no leak between requests)', async () => {
            await withServer(async (server) => {
                capturedClientOptions.length = 0;
                server.upsertTools([makeTokenEchoTool()]);
                const handler = getServer2RequestHandler(createServer2(server), 'tools/call');
                await callTool(
                    handler,
                    'token-echo-tool',
                    makeServer2Ctx({ clientInfo: { name: APIFY_AI_CLIENT_NAME, version: '1.0.0' } }),
                );
                await callTool(
                    handler,
                    'token-echo-tool',
                    makeServer2Ctx({ clientInfo: { name: 'some-other-client', version: '1.0.0' } }),
                );
                expect(capturedClientOptions.at(-2)).toMatchObject({ requestOrigin: 'APIFY_AI' });
                expect(capturedClientOptions.at(-1)).toMatchObject({ requestOrigin: 'MCP' });
            });
        });
    });

    describe('per-request server mode', () => {
        it('resolves apps mode from the request capabilities when the option is auto', async () => {
            await withServer(
                async (server) => {
                    const uiCapabilities = {
                        extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: [RESOURCE_MIME_TYPE] } },
                    };
                    expect(
                        server.resolveServerModeForClient({
                            method: 'initialize',
                            params: {
                                protocolVersion: MODERN_PROTOCOL_VERSION,
                                capabilities: uiCapabilities,
                                clientInfo: { name: 'ui-client', version: '1.0.0' },
                            },
                        }),
                    ).toBe(SERVER_MODE.APPS);
                    expect(server.resolveServerModeForClient(undefined)).toBe(SERVER_MODE.DEFAULT);
                },
                { serverMode: 'auto' },
            );
        });

        it('keeps an explicit server mode regardless of request capabilities', async () => {
            await withServer(
                async (server) => {
                    expect(server.resolveServerModeForClient(undefined)).toBe(SERVER_MODE.APPS);
                },
                { serverMode: SERVER_MODE.APPS },
            );
        });

        it('gates report-problem servability per request', async () => {
            await withServer(
                async (server) => {
                    expect(
                        server.isReportProblemServableForClient({
                            method: 'initialize',
                            params: {
                                protocolVersion: MODERN_PROTOCOL_VERSION,
                                capabilities: {},
                                clientInfo: { name: 'known-client', version: '1.0.0' },
                            },
                        }),
                    ).toBe(true);
                    expect(server.isReportProblemServableForClient(undefined)).toBe(false);
                },
                { telemetry: { enabled: true } },
            );
        });
    });

    describe('resources', () => {
        it('lists resources and templates', async () => {
            await withServer(async (server) => {
                const modern = createServer2(server);
                const list = await getServer2RequestHandler(modern, 'resources/list')(
                    { method: 'resources/list', params: {} },
                    makeServer2Ctx(),
                );
                expect(Array.isArray(list.resources)).toBe(true);
                const templates = await getServer2RequestHandler(modern, 'resources/templates/list')(
                    { method: 'resources/templates/list', params: {} },
                    makeServer2Ctx(),
                );
                expect(Array.isArray(templates.resourceTemplates)).toBe(true);
            });
        });

        it('reads with a token-scoped client tagged by the per-request origin', async () => {
            // Analogue of mcp.server.resource_request_origin: the token branch builds an ApifyClient
            // tagged with the request's own origin. Client is constructed before readResource runs,
            // so the unknown-widget rejection does not prevent capturing the constructor options.
            await withServer(async (server) => {
                capturedClientOptions.length = 0;
                const handler = getServer2RequestHandler(createServer2(server), 'resources/read');
                await handler(
                    { method: 'resources/read', params: { uri: 'ui://widget/unknown.html' } },
                    makeServer2Ctx({ clientInfo: { name: APIFY_AI_CLIENT_NAME, version: '1.0.0' } }),
                ).catch(() => undefined);
                expect(capturedClientOptions.at(-1)).toMatchObject({ token: 'fake-token', requestOrigin: 'APIFY_AI' });
            });
        });

        it('reads token-less (no client) when the request resolves no Apify token', async () => {
            // Payment-only-session behavior: with no token the read still executes, just with no
            // ApifyClient — the `token ? … : undefined` branch takes the undefined side.
            await withServer(
                async (server) => {
                    capturedClientOptions.length = 0;
                    const handler = getServer2RequestHandler(createServer2(server), 'resources/read');
                    // readResource runs and rejects the unknown resource — reached token-less, not
                    // short-circuited — and no token-scoped client was constructed.
                    await expect(
                        handler(
                            { method: 'resources/read', params: { uri: 'ui://widget/unknown.html' } },
                            makeServer2Ctx(),
                        ),
                    ).rejects.toThrow();
                    expect(capturedClientOptions.length).toBe(0);
                },
                { token: undefined },
            );
        });
    });

    describe('prompts', () => {
        it('lists prompts and rejects an unknown prompt name', async () => {
            await withServer(async (server) => {
                const modern = createServer2(server);
                const list = await getServer2RequestHandler(modern, 'prompts/list')(
                    { method: 'prompts/list', params: {} },
                    makeServer2Ctx(),
                );
                expect(Array.isArray(list.prompts)).toBe(true);
                await expect(
                    getServer2RequestHandler(modern, 'prompts/get')(
                        { method: 'prompts/get', params: { name: 'no-such-prompt' } },
                        makeServer2Ctx(),
                    ),
                ).rejects.toThrow(ProtocolError);
            });
        });
    });

    describe('prepareTelemetryData() per-request override', () => {
        it('reflects the per-request initializeRequestData override, not the instance option', async () => {
            await withServer(
                async (server) => {
                    const { telemetryData } = await prepareTelemetryData({
                        toolName: 'some-tool',
                        mcpSessionId: 's1',
                        // Empty token: skip the userId network fetch, keep telemetry data assembly.
                        apifyToken: '',
                        apifyMcpServer: server,
                        initializeRequestData: {
                            method: 'initialize',
                            params: {
                                protocolVersion: MODERN_PROTOCOL_VERSION,
                                capabilities: {},
                                clientInfo: { name: APIFY_AI_CLIENT_NAME, version: '9.9.9' },
                            },
                        },
                    });
                    expect(telemetryData?.mcp_client_name).toBe(APIFY_AI_CLIENT_NAME);
                    expect(telemetryData?.mcp_client_version).toBe('9.9.9');

                    const { telemetryData: withoutOverride } = await prepareTelemetryData({
                        toolName: 'some-tool',
                        mcpSessionId: 's1',
                        apifyToken: '',
                        apifyMcpServer: server,
                    });
                    // Instance has no initializeRequestData, so the un-overridden call sees no client.
                    expect(withoutOverride?.mcp_client_name).toBe('');
                },
                { telemetry: { enabled: true } },
            );
        });
    });

    describe('prepare()', () => {
        it('is a public hook that connect() runs before the transport connects', async () => {
            await withServer(async (server) => {
                const prepareSpy = vi.spyOn(server, 'prepare');
                const fakeTransport = {
                    start: vi.fn(async () => {}),
                    send: vi.fn(async () => {}),
                    close: vi.fn(async () => {}),
                };
                await server.connect(fakeTransport as never);
                expect(prepareSpy).toHaveBeenCalledTimes(1);
                expect(fakeTransport.start).toHaveBeenCalledTimes(1);
            });
        });
    });
});
