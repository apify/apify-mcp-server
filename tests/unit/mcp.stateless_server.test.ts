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
import { createStatelessServer } from '../../src/mcp/stateless_server.js';
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

const STATELESS_PROTOCOL_VERSION = '2026-07-28';

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

type StatelessHandlerFn = (req: Record<string, unknown>, ctx: ServerContext) => Promise<Record<string, unknown>>;

function getStatelessRequestHandler(statelessServer: unknown, method: string): StatelessHandlerFn {
    // eslint-disable-next-line no-underscore-dangle
    const handler = (statelessServer as { _requestHandlers: Map<string, StatelessHandlerFn> })._requestHandlers.get(
        method,
    );
    if (!handler) throw new Error(`Handler "${method}" not registered`);
    return handler;
}

function listStatelessHandlerMethods(statelessServer: unknown): string[] {
    // eslint-disable-next-line no-underscore-dangle
    return Array.from(
        (statelessServer as { _requestHandlers: Map<string, StatelessHandlerFn> })._requestHandlers.keys(),
    );
}

function makeStatelessContext(
    options: {
        clientInfo?: { name: string; version: string };
        capabilities?: Record<string, unknown>;
        authToken?: string;
        sessionId?: string;
    } = {},
): ServerContext {
    const { clientInfo, capabilities, authToken, sessionId } = options;
    const envelope: Record<string, unknown> = { [PROTOCOL_VERSION_META_KEY]: STATELESS_PROTOCOL_VERSION };
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

function callTool(handler: StatelessHandlerFn, name: string, ctx: ServerContext, args: Record<string, unknown> = {}) {
    return handler({ method: 'tools/call', params: { name, arguments: args } }, ctx);
}

describe('createStatelessServer()', () => {
    describe('registration surface', () => {
        it('registers the stateless surfaces and no tasks handlers', async () => {
            await withServer(async (server) => {
                const statelessServer = createStatelessServer(server);
                const methods = listStatelessHandlerMethods(statelessServer);
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
                expect(() => createStatelessServer(server)).not.toThrow();
            });
        });
    });

    describe('tasks/* rejection', () => {
        it('rejects a tasks/* request with JSON-RPC -32601 through the SDK dispatch', async () => {
            await withServer(async (server) => {
                const statelessServer = createStatelessServer(server);
                const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
                const responses: { id?: number | string; error?: { code?: number } }[] = [];
                clientTransport.onmessage = (message: JSONRPCMessage) => {
                    responses.push(message as { id?: number | string; error?: { code?: number } });
                };
                await clientTransport.start();
                await statelessServer.connect(serverTransport);

                const tasksRequest = {
                    jsonrpc: '2.0' as const,
                    id: 42,
                    method: 'tasks/get',
                    params: { taskId: 'nonexistent' },
                };
                await clientTransport.send(tasksRequest);
                await statelessServer.close();

                const response = responses.find((r) => r.id === 42);
                expect(response?.error?.code).toBe(-32601);
            });
        });
    });

    describe('tools/list', () => {
        it('lists the tools of the backing ActorsMcpServer', async () => {
            await withServer(async (server) => {
                server.upsertTools([makeTokenEchoTool()]);
                const statelessServer = createStatelessServer(server);
                const result = await getStatelessRequestHandler(statelessServer, 'tools/list')(
                    { method: 'tools/list', params: {} },
                    makeStatelessContext(),
                );
                const names = (result.tools as { name: string }[]).map((t) => t.name);
                expect(names).toContain('token-echo-tool');
            });
        });

        it('admits report-problem via the real load path only for a servable request', async () => {
            await withServer(
                async (server) => {
                    await server.loadToolsByName([HELPER_TOOLS.PROBLEM_REPORT], {} as never);
                    expect(server.tools.has(HELPER_TOOLS.PROBLEM_REPORT)).toBe(false);

                    const statelessServer = createStatelessServer(server);
                    expect(server.tools.has(HELPER_TOOLS.PROBLEM_REPORT)).toBe(false);
                    // eslint-disable-next-line no-underscore-dangle
                    expect((statelessServer as unknown as { _instructions?: string })._instructions).toContain(
                        HELPER_TOOLS.PROBLEM_REPORT,
                    );
                    const handler = getStatelessRequestHandler(statelessServer, 'tools/list');

                    const servable = await handler(
                        { method: 'tools/list', params: {} },
                        makeStatelessContext({ clientInfo: { name: 'test-client', version: '1.0.0' } }),
                    );
                    expect((servable.tools as { name: string }[]).map((t) => t.name)).toContain(
                        HELPER_TOOLS.PROBLEM_REPORT,
                    );

                    const notServable = await handler({ method: 'tools/list', params: {} }, makeStatelessContext());
                    expect((notServable.tools as { name: string }[]).map((t) => t.name)).not.toContain(
                        HELPER_TOOLS.PROBLEM_REPORT,
                    );
                },
                { telemetry: { enabled: true } },
            );
        });

        it('withholds report-problem and does not advertise it in instructions when telemetry is off', async () => {
            await withServer(async (server) => {
                expect(server.telemetryEnabled).toBe(false);
                await server.loadToolsByName([HELPER_TOOLS.PROBLEM_REPORT], {} as never);
                expect(server.tools.has(HELPER_TOOLS.PROBLEM_REPORT)).toBe(false);

                const statelessServer = createStatelessServer(server);
                expect(server.tools.has(HELPER_TOOLS.PROBLEM_REPORT)).toBe(false);
                // eslint-disable-next-line no-underscore-dangle
                expect((statelessServer as unknown as { _instructions?: string })._instructions).not.toContain(
                    HELPER_TOOLS.PROBLEM_REPORT,
                );

                const notServable = await getStatelessRequestHandler(statelessServer, 'tools/list')(
                    { method: 'tools/list', params: {} },
                    makeStatelessContext({ clientInfo: { name: 'test-client', version: '1.0.0' } }),
                );
                expect((notServable.tools as { name: string }[]).map((t) => t.name)).not.toContain(
                    HELPER_TOOLS.PROBLEM_REPORT,
                );
            });
        });

        it('composes Apps tools for an Apps-capable request when the option is auto', async () => {
            await withServer(
                async (server) => {
                    await server.loadToolsByName([HELPER_TOOLS.ACTOR_CALL], {} as never);
                    const handler = getStatelessRequestHandler(createStatelessServer(server), 'tools/list');
                    const result = await handler(
                        { method: 'tools/list', params: {} },
                        makeStatelessContext({
                            clientInfo: { name: 'apps-client', version: '1.0.0' },
                            capabilities: {
                                extensions: {
                                    'io.modelcontextprotocol/ui': { mimeTypes: [RESOURCE_MIME_TYPE] },
                                },
                            },
                        }),
                    );
                    const names = (result.tools as { name: string }[]).map((tool) => tool.name);
                    expect(names).toContain(HELPER_TOOLS.ACTOR_CALL);
                    expect(names).toContain(HELPER_TOOLS.ACTOR_CALL_WIDGET);
                },
                { serverMode: 'auto' },
            );
        });
    });

    describe('tools/call token resolution', () => {
        it('resolves the Apify token from ctx.http.authInfo.token over the instance option', async () => {
            await withServer(async (server) => {
                server.upsertTools([makeTokenEchoTool()]);
                const handler = getStatelessRequestHandler(createStatelessServer(server), 'tools/call');
                const result = await callTool(
                    handler,
                    'token-echo-tool',
                    makeStatelessContext({ authToken: 'auth-info-token' }),
                );
                const content = result.content as { type: string; text: string }[];
                expect(content[0].text).toBe('auth-info-token');
            });
        });

        it('falls back to the instance token when the request carries no authInfo', async () => {
            await withServer(async (server) => {
                server.upsertTools([makeTokenEchoTool()]);
                const handler = getStatelessRequestHandler(createStatelessServer(server), 'tools/call');
                const result = await callTool(handler, 'token-echo-tool', makeStatelessContext());
                const content = result.content as { type: string; text: string }[];
                expect(content[0].text).toBe('fake-token');
            });
        });
    });

    describe('tools/call invalid-call rejections', () => {
        it('rejects an unknown tool with an InvalidParams protocol error', async () => {
            await withServer(async (server) => {
                const handler = getStatelessRequestHandler(createStatelessServer(server), 'tools/call');
                await expect(callTool(handler, 'no-such-tool', makeStatelessContext())).rejects.toThrow(ProtocolError);
            });
        });

        it('rejects when no token is resolvable and unauthenticated mode is off', async () => {
            await withServer(
                async (server) => {
                    server.upsertTools([makeTokenEchoTool()]);
                    const handler = getStatelessRequestHandler(createStatelessServer(server), 'tools/call');
                    await expect(callTool(handler, 'token-echo-tool', makeStatelessContext())).rejects.toThrow(
                        /Apify API token is required/,
                    );
                },
                { token: undefined },
            );
        });

        it('never invokes the v1 sendLoggingMessage side-channel on the stateless path', async () => {
            await withServer(async (server) => {
                const sendLogSpy = vi.spyOn(server.server, 'sendLoggingMessage').mockResolvedValue(undefined);
                const handler = getStatelessRequestHandler(createStatelessServer(server), 'tools/call');
                await expect(callTool(handler, 'no-such-tool', makeStatelessContext())).rejects.toThrow(ProtocolError);
                expect(sendLogSpy).not.toHaveBeenCalled();
            });
        });

        it.each([undefined, { name: 'Claude Desktop', version: '1.0.0' }])(
            'rejects a direct report-problem call when the request client is not servable',
            async (clientInfo) => {
                await withServer(
                    async (server) => {
                        await server.loadToolsByName([HELPER_TOOLS.PROBLEM_REPORT], {} as never);
                        const handler = getStatelessRequestHandler(createStatelessServer(server), 'tools/call');
                        await expect(
                            callTool(handler, HELPER_TOOLS.PROBLEM_REPORT, makeStatelessContext({ clientInfo }), {
                                message: 'The tool failed.',
                            }),
                        ).rejects.toThrow(ProtocolError);
                    },
                    { telemetry: { enabled: true } },
                );
            },
        );
    });

    describe('tools/call result projection', () => {
        it('projects a successful result through projectCallToolResult with the tool output schema', async () => {
            await withServer(async (server) => {
                const tool = makeTokenEchoTool();
                tool.outputSchema = { type: 'object' } as ToolEntry['outputSchema'];
                server.upsertTools([tool]);
                const statelessServer = createStatelessServer(server);
                const projectSpy = vi.spyOn(statelessServer, 'projectCallToolResult');
                const handler = getStatelessRequestHandler(statelessServer, 'tools/call');
                await callTool(handler, 'token-echo-tool', makeStatelessContext());
                expect(projectSpy).toHaveBeenCalledTimes(1);
                expect(projectSpy.mock.calls[0][1]).toEqual({ type: 'object' });
            });
        });

        it('projects an engine-classified prepare failure (PreparedCallError) with no output schema', async () => {
            await withServer(async (server) => {
                server.upsertTools([makeAjvThrowingTool()]);
                const statelessServer = createStatelessServer(server);
                const projectSpy = vi.spyOn(statelessServer, 'projectCallToolResult');
                const handler = getStatelessRequestHandler(statelessServer, 'tools/call');
                const result = await callTool(handler, 'ajv-throwing-tool', makeStatelessContext());
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
                const statelessServer = createStatelessServer(server);
                const projectSpy = vi.spyOn(statelessServer, 'projectCallToolResult');
                const handler = getStatelessRequestHandler(statelessServer, 'tools/call');
                await expect(callTool(handler, 'unknown-type-tool', makeStatelessContext())).rejects.toThrow(
                    ProtocolError,
                );
                expect(projectSpy).not.toHaveBeenCalled();
            });
        });
    });

    describe('tools/call error-kind parity with v1', () => {
        const cases: { label: string; makeError: () => unknown }[] = [
            { label: 'payment-required (402)', makeError: () => makePaymentRequiredError(X402_PAYMENT_DATA) },
            { label: 'permission-approval', makeError: makePermissionApprovalError },
            { label: 'generic execution error', makeError: () => new Error('boom') },
        ];

        for (const { label, makeError } of cases) {
            it(`projects a ${label} failure to the same wire shape as v1`, async () => {
                await withServer(async (server) => {
                    vi.spyOn(log, 'error').mockImplementation(() => log);
                    vi.spyOn(log, 'exception').mockImplementation(() => log);
                    server.upsertTools([makeThrowingTool({ error: makeError() })]);

                    const v1Result = await getRequestHandler(server, 'tools/call')(
                        {
                            method: 'tools/call',
                            params: { name: 'test-throwing-tool', arguments: {}, _meta: { mcpSessionId: 's1' } },
                        },
                        { signal: { aborted: false }, sendNotification: vi.fn() },
                    );

                    const statelessResult = await callTool(
                        getStatelessRequestHandler(createStatelessServer(server), 'tools/call'),
                        'test-throwing-tool',
                        makeStatelessContext(),
                    );

                    expect(statelessResult.isError).toBe(true);
                    expect(statelessResult).toEqual(v1Result);
                    vi.restoreAllMocks();
                });
            });
        }

        it('carries the x402 payment payload and FAILED execution telemetry through the stateless projection', async () => {
            await withServer(async (server) => {
                vi.spyOn(log, 'error').mockImplementation(() => log);
                vi.spyOn(log, 'exception').mockImplementation(() => log);
                const handler = getStatelessRequestHandler(createStatelessServer(server), 'tools/call');

                server.upsertTools([
                    makeThrowingTool({ name: 'pay-tool', error: makePaymentRequiredError(X402_PAYMENT_DATA) }),
                ]);
                const payResult = await callTool(handler, 'pay-tool', makeStatelessContext());
                expect(payResult.isError).toBe(true);
                expect(payResult.structuredContent).toEqual(X402_PAYMENT_DATA);

                server.upsertTools([makeThrowingTool({ name: 'exec-tool', error: new Error('boom') })]);
                const execResult = await callTool(handler, 'exec-tool', makeStatelessContext());
                expect(execResult.isError).toBe(true);
                expect(execResult.toolTelemetry).toEqual({ toolStatus: TOOL_STATUS.FAILED });
                expect((execResult.content as { text: string }[])[0].text).toContain('boom');
                vi.restoreAllMocks();
            });
        });
    });

    describe('tools/call tool-type parity with v1', () => {
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
                const statelessResult = await callTool(
                    getStatelessRequestHandler(createStatelessServer(server), 'tools/call'),
                    'test-actor-tool',
                    makeStatelessContext(),
                );

                expect(statelessResult).toEqual({ content: [{ type: 'text', text: 'actor ok' }] });
                expect(statelessResult).toEqual(v1Result);
                vi.restoreAllMocks();
            });
        });

        it('projects an ACTOR_MCP connect failure to the same soft-fail result shape as v1', async () => {
            await withServer(async (server) => {
                vi.spyOn(log, 'softFail').mockImplementation(() => log);
                vi.spyOn(mcpClient, 'connectMCPClient').mockResolvedValue(null);
                server.upsertTools([makeActorMcpTool()]);

                const v1Result = await getRequestHandler(server, 'tools/call')(
                    {
                        method: 'tools/call',
                        params: { name: 'test-actor-mcp-tool', arguments: {}, _meta: { mcpSessionId: 's1' } },
                    },
                    { signal: { aborted: false }, sendNotification: vi.fn() },
                );
                const statelessResult = await callTool(
                    getStatelessRequestHandler(createStatelessServer(server), 'tools/call'),
                    'test-actor-mcp-tool',
                    makeStatelessContext(),
                );

                expect(statelessResult.isError).toBe(true);
                expect((statelessResult.content as { text: string }[])[0].text).toContain(
                    'Failed to connect to MCP server',
                );
                expect(statelessResult).toEqual(v1Result);
                vi.restoreAllMocks();
            });
        });
    });

    describe('tools/call request-origin attribution', () => {
        it('attributes APIFY_AI when the envelope client identity is the Apify AI client', async () => {
            await withServer(async (server) => {
                capturedClientOptions.length = 0;
                server.upsertTools([makeTokenEchoTool()]);
                const handler = getStatelessRequestHandler(createStatelessServer(server), 'tools/call');
                await callTool(
                    handler,
                    'token-echo-tool',
                    makeStatelessContext({ clientInfo: { name: APIFY_AI_CLIENT_NAME, version: '1.0.0' } }),
                );
                expect(capturedClientOptions.at(-1)).toMatchObject({ requestOrigin: 'APIFY_AI' });
            });
        });

        it('falls back to MCP when the envelope client identity is absent or unknown', async () => {
            await withServer(async (server) => {
                capturedClientOptions.length = 0;
                server.upsertTools([makeTokenEchoTool()]);
                const handler = getStatelessRequestHandler(createStatelessServer(server), 'tools/call');
                await callTool(
                    handler,
                    'token-echo-tool',
                    makeStatelessContext({ clientInfo: { name: 'some-other-client', version: '1.0.0' } }),
                );
                expect(capturedClientOptions.at(-1)).toMatchObject({ requestOrigin: 'MCP' });
                await callTool(handler, 'token-echo-tool', makeStatelessContext());
                expect(capturedClientOptions.at(-1)).toMatchObject({ requestOrigin: 'MCP' });
            });
        });

        it('ignores initialize-scoped identity when the envelope client identity is absent', async () => {
            await withServer(
                async (server) => {
                    capturedClientOptions.length = 0;
                    server.upsertTools([makeTokenEchoTool()]);
                    const handler = getStatelessRequestHandler(createStatelessServer(server), 'tools/call');
                    await callTool(handler, 'token-echo-tool', makeStatelessContext());
                    expect(capturedClientOptions.at(-1)).toMatchObject({ requestOrigin: 'MCP' });
                },
                {
                    initializeRequestData: {
                        method: 'initialize',
                        params: {
                            protocolVersion: '2025-06-18',
                            capabilities: {},
                            clientInfo: { name: APIFY_AI_CLIENT_NAME, version: '1.0.0' },
                        },
                    },
                },
            );
        });

        it('derives identity per request on the same server instance (no leak between requests)', async () => {
            await withServer(async (server) => {
                capturedClientOptions.length = 0;
                server.upsertTools([makeTokenEchoTool()]);
                const handler = getStatelessRequestHandler(createStatelessServer(server), 'tools/call');
                await callTool(
                    handler,
                    'token-echo-tool',
                    makeStatelessContext({ clientInfo: { name: APIFY_AI_CLIENT_NAME, version: '1.0.0' } }),
                );
                await callTool(
                    handler,
                    'token-echo-tool',
                    makeStatelessContext({ clientInfo: { name: 'some-other-client', version: '1.0.0' } }),
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
                                protocolVersion: STATELESS_PROTOCOL_VERSION,
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
                                protocolVersion: STATELESS_PROTOCOL_VERSION,
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
                const statelessServer = createStatelessServer(server);
                const list = await getStatelessRequestHandler(statelessServer, 'resources/list')(
                    { method: 'resources/list', params: {} },
                    makeStatelessContext(),
                );
                expect(Array.isArray(list.resources)).toBe(true);
                const templates = await getStatelessRequestHandler(statelessServer, 'resources/templates/list')(
                    { method: 'resources/templates/list', params: {} },
                    makeStatelessContext(),
                );
                expect(Array.isArray(templates.resourceTemplates)).toBe(true);
            });
        });

        it('reads with a token-scoped client tagged by the per-request origin', async () => {
            await withServer(async (server) => {
                capturedClientOptions.length = 0;
                const handler = getStatelessRequestHandler(createStatelessServer(server), 'resources/read');
                await handler(
                    { method: 'resources/read', params: { uri: 'ui://widget/unknown.html' } },
                    makeStatelessContext({ clientInfo: { name: APIFY_AI_CLIENT_NAME, version: '1.0.0' } }),
                ).catch(() => undefined);
                expect(capturedClientOptions.at(-1)).toMatchObject({ token: 'fake-token', requestOrigin: 'APIFY_AI' });
            });
        });

        it('reads token-less (no client) when the request resolves no Apify token', async () => {
            await withServer(
                async (server) => {
                    capturedClientOptions.length = 0;
                    const handler = getStatelessRequestHandler(createStatelessServer(server), 'resources/read');
                    await expect(
                        handler(
                            { method: 'resources/read', params: { uri: 'ui://widget/unknown.html' } },
                            makeStatelessContext(),
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
                const statelessServer = createStatelessServer(server);
                const list = await getStatelessRequestHandler(statelessServer, 'prompts/list')(
                    { method: 'prompts/list', params: {} },
                    makeStatelessContext(),
                );
                expect(Array.isArray(list.prompts)).toBe(true);
                await expect(
                    getStatelessRequestHandler(statelessServer, 'prompts/get')(
                        { method: 'prompts/get', params: { name: 'no-such-prompt' } },
                        makeStatelessContext(),
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
                        apifyToken: '',
                        apifyMcpServer: server,
                        initializeRequestData: {
                            method: 'initialize',
                            params: {
                                protocolVersion: STATELESS_PROTOCOL_VERSION,
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
                    expect(withoutOverride?.mcp_client_name).toBe('');
                },
                { telemetry: { enabled: true } },
            );
        });

        it('preserves an explicitly absent per-request client identity', async () => {
            await withServer(
                async (server) => {
                    const { telemetryData } = await prepareTelemetryData({
                        toolName: 'some-tool',
                        mcpSessionId: 's1',
                        apifyToken: '',
                        apifyMcpServer: server,
                        initializeRequestData: undefined,
                    });
                    expect(telemetryData?.mcp_client_name).toBe('');
                },
                {
                    telemetry: { enabled: true },
                    initializeRequestData: {
                        method: 'initialize',
                        params: {
                            protocolVersion: '2025-06-18',
                            capabilities: {},
                            clientInfo: { name: APIFY_AI_CLIENT_NAME, version: '1.0.0' },
                        },
                    },
                },
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
