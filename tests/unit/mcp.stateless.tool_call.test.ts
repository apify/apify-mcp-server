import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import Ajv from 'ajv';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import log from '@apify/log';

import type * as ApifyClientModule from '../../src/apify_client.js';
import { REQUEST_ORIGIN } from '../../src/apify_client.js';
import { APIFY_AI_CLIENT_NAME, HELPER_TOOLS } from '../../src/const.js';
import * as mcpClient from '../../src/mcp/client.js';
import type { ActorsMcpServer } from '../../src/mcp/server.js';
import { X402PaymentProvider } from '../../src/payments/x402.js';
import * as telemetry from '../../src/telemetry.js';
import { actorExecutor } from '../../src/tools/actors/actor_executor.js';
import * as callActor from '../../src/tools/actors/call_actor.js';
import type { ActorsMcpServerOptions, Input, ToolEntry, ToolInputSchema } from '../../src/types.js';
import { TOOL_TYPE } from '../../src/types.js';
import { compileSchema } from '../../src/utils/ajv.js';
import { respondRaw } from '../../src/utils/mcp.js';
import type * as ToolsLoaderModule from '../../src/utils/tools_loader.js';
import { getActors } from '../../src/utils/tools_loader.js';
import {
    getRequestHandler,
    makeArgsRecorderTool,
    makePaymentRequiredError,
    makeThrowingTool,
    STATELESS_PROTOCOL_VERSION,
    withServer,
    withStatelessServer,
    X402_PAYMENT_DATA,
} from './helpers/mcp_server.js';

vi.mock('../../src/utils/tools_loader.js', async (importOriginal) => {
    const actual = await importOriginal<typeof ToolsLoaderModule>();
    return { ...actual, getActors: vi.fn() };
});

// Capturing ApifyClient construction is how the request-origin tag is observed; it is a static
// header on the real client, invisible from the outside.
const { capturedClientOptions } = vi.hoisted(() => ({ capturedClientOptions: [] as { requestOrigin?: string }[] }));

vi.mock('../../src/apify_client.js', async (importOriginal) => {
    const actual = await importOriginal<typeof ApifyClientModule>();
    return {
        ...actual,
        ApifyClient: class {
            constructor(options: { requestOrigin?: string }) {
                capturedClientOptions.push(options);
            }
        },
    };
});

const getActorsMock = vi.mocked(getActors);

function makeActorTool(): ToolEntry {
    return {
        type: TOOL_TYPE.ACTOR,
        name: 'test-actor-tool',
        description: 'actor',
        inputSchema: { type: 'object', properties: {} } as ToolInputSchema,
        ajvValidate: compileSchema({ type: 'object', properties: {} }),
        actorId: 'test/actor',
        actorFullName: 'test/actor',
    } as ToolEntry;
}

function makeActorMcpTool(): ToolEntry {
    return {
        type: TOOL_TYPE.ACTOR_MCP,
        name: 'test-actor-mcp-tool',
        description: 'actor-mcp',
        inputSchema: { type: 'object', properties: {} } as ToolInputSchema,
        ajvValidate: compileSchema({ type: 'object', properties: {} }),
        originToolName: 'origin-tool',
        actorId: 'test/actor',
        serverId: 'server-id',
        serverUrl: 'https://example.invalid/mcp',
    } as ToolEntry;
}

/**
 * A paid `call-actor` whose declared success shape the payment provider widens with the x402
 * PaymentRequired branch — the schema a strict client validates `structuredContent` against.
 */
function makePaidCallActorTool(): ToolEntry {
    return {
        type: TOOL_TYPE.INTERNAL,
        name: HELPER_TOOLS.ACTOR_CALL,
        description: 'calls an Actor',
        inputSchema: { type: 'object', properties: { actor: { type: 'string' } } } as ToolInputSchema,
        ajvValidate: compileSchema({ type: 'object', properties: { actor: { type: 'string' } } }),
        paymentRequired: true,
        outputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] },
        call: async () => respondRaw({ content: [{ type: 'text', text: 'dispatch is never reached' }] }),
    } as ToolEntry;
}

/**
 * A proxied MCP client that relays `notifications` through the notification handlers the dispatch
 * registered on it, then answers with `result` — the only way a remote Actor-MCP notification
 * reaches the adapter's forwarder.
 */
function stubNotifyingClient(notifications: { method: string; params: Record<string, unknown> }[], result: unknown) {
    const handlers = new Map<string, (notification: unknown) => Promise<void>>();
    return {
        setNotificationHandler: (
            schema: { shape: { method: { value: string } } },
            handler: (notification: unknown) => Promise<void>,
        ) => {
            handlers.set(schema.shape.method.value, handler);
        },
        callTool: async () => {
            for (const notification of notifications) {
                const handler = handlers.get(notification.method);
                if (!handler) throw new Error(`Dispatch registered no handler for ${notification.method}`);
                await handler(notification);
            }
            return result;
        },
        close: async () => {},
    };
}

/** Log lines a test reads back, silenced so the assertions are the only output. */
function captureSoftFails(): { calls: [unknown, Record<string, unknown>?][] } {
    const spy = vi.spyOn(log, 'softFail').mockImplementation(() => log);
    return spy.mock as unknown as { calls: [unknown, Record<string, unknown>?][] };
}

function softFailsStartingWith(
    softFails: { calls: [unknown, Record<string, unknown>?][] },
    prefix: string,
): [unknown, Record<string, unknown>?][] {
    return softFails.calls.filter(([message]) => String(message).startsWith(prefix));
}

async function loadSource(server: ActorsMcpServer, actorTools: ToolEntry[], input: Input = { tools: [] }) {
    getActorsMock.mockResolvedValue(actorTools);
    await server.loadToolsFromInput(input, {} as never);
}

const LEGACY_INITIALIZE = {
    method: 'initialize',
    params: {
        protocolVersion: '2025-06-18',
        clientInfo: { name: 'test-client', version: '1.0.0' },
        capabilities: {},
    },
};

/**
 * The same call served by the stateful path, for parity comparison. Values that only exist on that
 * path (a session id) are supplied the way it requires them. Each path gets its own tool objects
 * from `buildTools`, so neither can observe the other's teardown.
 */
async function callViaLegacy(
    buildTools: () => ToolEntry[],
    toolName: string,
    options?: Partial<ActorsMcpServerOptions>,
    args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
    return await withServer(async (server) => {
        await loadSource(server, buildTools());
        await getRequestHandler(server, 'initialize')(LEGACY_INITIALIZE, {});
        const result = await getRequestHandler(server, 'tools/call')(
            { method: 'tools/call', params: { name: toolName, arguments: args, _meta: { mcpSessionId: 's1' } } },
            { signal: { aborted: false }, sendNotification: vi.fn() },
        );
        return result;
    }, options);
}

async function listViaLegacy(buildTools: () => ToolEntry[], input: Input): Promise<Record<string, unknown>> {
    return await withServer(async (server) => {
        await loadSource(server, buildTools(), input);
        await getRequestHandler(server, 'initialize')(LEGACY_INITIALIZE, {});
        const result = await getRequestHandler(server, 'tools/list')({ method: 'tools/list', params: {} }, {});
        return result;
    });
}

/** Wire-normalize a stateful result so it compares against one that crossed a JSON boundary. */
function asWire(result: unknown): unknown {
    return JSON.parse(JSON.stringify(result));
}

describe('createStatelessServer() tools/call', () => {
    beforeEach(() => {
        capturedClientOptions.length = 0;
    });

    afterEach(() => {
        getActorsMock.mockReset();
        getActorsMock.mockResolvedValue([]);
        vi.restoreAllMocks();
    });

    describe('token precedence', () => {
        it('prefers the auth info the serving entry received over anything the client sent', async () => {
            await withStatelessServer(
                async ({ server, call }) => {
                    const { tool, received } = makeArgsRecorderTool();
                    await loadSource(server, [tool]);

                    await call(
                        'tools/call',
                        { name: tool.name, arguments: {} },
                        {
                            authInfo: { token: 'validated-token', clientId: '', scopes: [] },
                            meta: { apifyToken: 'client-supplied-token' },
                        },
                    );

                    expect(received.apifyToken).toBe('validated-token');
                },
                { token: 'configured-token' },
            );
        });

        it('falls back to the client-supplied token when the entry has no auth info', async () => {
            await withStatelessServer(
                async ({ server, call }) => {
                    const { tool, received } = makeArgsRecorderTool();
                    await loadSource(server, [tool]);

                    await call(
                        'tools/call',
                        { name: tool.name, arguments: {} },
                        { meta: { apifyToken: 'client-supplied-token' } },
                    );

                    expect(received.apifyToken).toBe('client-supplied-token');
                },
                { token: 'configured-token' },
            );
        });

        it('falls back to the configured token when the request carries none', async () => {
            await withStatelessServer(
                async ({ server, call }) => {
                    const { tool, received } = makeArgsRecorderTool();
                    await loadSource(server, [tool]);

                    await call('tools/call', { name: tool.name, arguments: {} });

                    expect(received.apifyToken).toBe('configured-token');
                },
                { token: 'configured-token' },
            );
        });
    });

    it('threads no session id into the tool call', async () => {
        await withStatelessServer(async ({ server, call }) => {
            const { tool, received } = makeArgsRecorderTool();
            await loadSource(server, [tool]);

            const response = await call('tools/call', { name: tool.name, arguments: {} });

            // The recorded token proves the tool actually ran — without it, an absent session id
            // would also be what a call that never reached the tool leaves behind.
            expect(response.error).toBeUndefined();
            expect(received.apifyToken).toBe('fake-token');
            expect(received.mcpSessionId).toBeUndefined();
        });
    });

    it('tags the Apify client with the request-origin of the identity the request declared', async () => {
        await withStatelessServer(async ({ server, call }) => {
            const { tool } = makeArgsRecorderTool();
            await loadSource(server, [tool]);

            await call('tools/call', { name: tool.name, arguments: {} }, { client: { name: APIFY_AI_CLIENT_NAME } });

            expect(capturedClientOptions.map((options) => options.requestOrigin)).toContain(REQUEST_ORIGIN.APIFY_AI);
        });
    });

    describe('parity with the stateful path', () => {
        it('lists the same tools for the same sources', async () => {
            const buildTools = () => [makeActorTool(), makeActorMcpTool(), makeArgsRecorderTool().tool];
            const input: Input = { tools: [] };
            const legacy = await listViaLegacy(buildTools, input);

            await withStatelessServer(async ({ server, call }) => {
                await loadSource(server, buildTools(), input);

                const response = await call('tools/list');

                expect(response.result?.tools).toEqual(asWire(legacy.tools));
            });
        });

        it('returns the same payload for an INTERNAL tool', async () => {
            const buildTools = () => [makeArgsRecorderTool().tool];
            const legacy = await callViaLegacy(buildTools, 'recorder-tool');

            await withStatelessServer(async ({ server, call }) => {
                await loadSource(server, buildTools());

                const response = await call('tools/call', { name: 'recorder-tool', arguments: {} });

                expect(response.result).toMatchObject(asWire(legacy) as Record<string, unknown>);
            });
        });

        it('returns the same payload for an ACTOR tool', async () => {
            const actorResult = { content: [{ type: 'text', text: 'actor ok' }], structuredContent: { runId: 'r1' } };
            vi.spyOn(actorExecutor, 'executeActorTool').mockResolvedValue(actorResult as never);
            const legacy = await callViaLegacy(() => [makeActorTool()], 'test-actor-tool');

            await withStatelessServer(async ({ server, call }) => {
                await loadSource(server, [makeActorTool()]);

                const response = await call('tools/call', { name: 'test-actor-tool', arguments: {} });

                expect(response.result).toMatchObject(asWire(legacy) as Record<string, unknown>);
            });
        });

        it('returns the same payload for an ACTOR_MCP tool', async () => {
            const proxiedResult = { content: [{ type: 'text', text: 'proxied ok' }] };
            vi.spyOn(mcpClient, 'connectMCPClient').mockResolvedValue({
                callTool: vi.fn().mockResolvedValue(proxiedResult),
                close: vi.fn().mockResolvedValue(undefined),
                setNotificationHandler: vi.fn(),
            } as never);
            const legacy = await callViaLegacy(() => [makeActorMcpTool()], 'test-actor-mcp-tool');

            await withStatelessServer(async ({ server, call }) => {
                await loadSource(server, [makeActorMcpTool()]);

                const response = await call('tools/call', { name: 'test-actor-mcp-tool', arguments: {} });

                expect(response.result).toMatchObject(asWire(legacy) as Record<string, unknown>);
            });
        });

        it('emits the same telemetry properties, apart from the session id and protocol revision', async () => {
            const trackSpy = vi.spyOn(telemetry, 'trackToolCall').mockImplementation(() => {});
            const options = { token: undefined, allowUnauthMode: true, telemetry: { enabled: true } };

            await callViaLegacy(() => [makeArgsRecorderTool().tool], 'recorder-tool', options);
            const legacyProperties = trackSpy.mock.calls[0][2];
            trackSpy.mockClear();

            await withStatelessServer(async ({ server, call }) => {
                await loadSource(server, [makeArgsRecorderTool().tool]);
                await call('tools/call', { name: 'recorder-tool', arguments: {} });
            }, options);
            const statelessProperties = trackSpy.mock.calls[0][2];

            expect(Object.keys(statelessProperties).sort()).toEqual(Object.keys(legacyProperties).sort());
            // Only the two values that describe the request itself may differ; both are deliberate.
            expect({ ...statelessProperties, tool_exec_time_ms: 0 }).toEqual({
                ...legacyProperties,
                tool_exec_time_ms: 0,
                mcp_session_id: '',
                mcp_protocol_version: STATELESS_PROTOCOL_VERSION,
            });
        });
    });

    it('projects the result through the SDK wire codec', async () => {
        // On this revision the codec appends a non-object `structuredContent` as text content when
        // the result carries none (SEP-2106 §4.3), and leaves the structured value alone. Reaching
        // the wire without that text block would mean the handler skipped `projectCallToolResult`.
        const buildTool = () =>
            ({
                type: TOOL_TYPE.INTERNAL,
                name: 'structured-scalar-tool',
                description: 'returns a non-object structuredContent',
                inputSchema: { type: 'object', properties: {} } as ToolInputSchema,
                ajvValidate: compileSchema({ type: 'object', properties: {} }),
                call: async () => respondRaw({ content: [], structuredContent: 42 as never }),
            }) as ToolEntry;

        await withStatelessServer(async ({ server, call }) => {
            await loadSource(server, [buildTool()]);

            const response = await call('tools/call', { name: 'structured-scalar-tool', arguments: {} });

            expect(response.result?.structuredContent).toBe(42);
            expect(response.result?.content).toEqual([{ type: 'text', text: '42' }]);
        });
    });

    it('projects a payment-classified pre-dispatch failure against the tool it named', async () => {
        // The standby check runs inside `prepareToolCall`, before dispatch; a 402 from it is
        // classified there and comes back as an already-built result, so the handler returns through
        // its `'result' in prepared` branch — the one return path that skipped the tool's schema.
        // The payload rides `structuredContent`, which is exactly what a paid tool's widened
        // outputSchema exists to keep valid for strict clients (#917).
        vi.spyOn(callActor, 'checkPaymentProviderStandbyConflict').mockRejectedValue(
            makePaymentRequiredError(X402_PAYMENT_DATA),
        );
        const args = { actor: 'apify/rag-web-browser' };
        const options = { paymentProvider: new X402PaymentProvider() };
        const legacy = await callViaLegacy(() => [makePaidCallActorTool()], HELPER_TOOLS.ACTOR_CALL, options, args);

        await withStatelessServer(async ({ server, call }) => {
            await loadSource(server, [makePaidCallActorTool()]);

            const response = await call('tools/call', { name: HELPER_TOOLS.ACTOR_CALL, arguments: args });

            expect(response.result?.isError).toBe(true);
            expect(response.result?.structuredContent).toEqual(X402_PAYMENT_DATA);
            // The projected payload validates against the schema this request advertised for the
            // tool — the widened `anyOf`, read back off the served tool set.
            const outputSchema = server.tools.get(HELPER_TOOLS.ACTOR_CALL)?.outputSchema as object;
            const validate = new Ajv({ strict: false, allErrors: true }).compile(outputSchema);
            expect(validate(response.result?.structuredContent)).toBe(true);
            // Byte-for-byte what the stateful path returns for the same failure.
            expect(response.result).toMatchObject(asWire(legacy) as Record<string, unknown>);
        }, options);
    });

    it('answers an unknown tool name with an invalid-params protocol error', async () => {
        await withStatelessServer(async ({ server, call }) => {
            await loadSource(server, []);

            const response = await call('tools/call', { name: 'no-such-tool', arguments: {} });

            expect(response.error?.code).toBe(-32602);
            expect(response.error?.message).toContain('was not found');
        });
    });

    it('re-codes a protocol error escaping the shared engine onto the v2 wire', async () => {
        // The engine still speaks v1 protocol errors and re-throws them (tool_call_engine.ts), so an
        // McpError from a tool reaches the handler's catch and must land on the wire with its own
        // code, message and data — not flattened to a generic internal error.
        await withStatelessServer(async ({ server, call }) => {
            await loadSource(server, [
                makeThrowingTool({
                    name: 'mcp-error-tool',
                    error: new McpError(ErrorCode.InvalidRequest, 'protocol boom', { detail: 'kept' }),
                }),
            ]);

            const response = await call('tools/call', { name: 'mcp-error-tool', arguments: {} });

            expect(response.error?.code).toBe(-32600);
            expect(response.error?.message).toContain('protocol boom');
            expect(response.error?.data).toEqual({ detail: 'kept' });
        });
    });

    describe('notification and log side channels', () => {
        it('forwards what the revision serves and drops what it refuses, without failing the call', async () => {
            // The forwarder is the only crossing between the shared engine's v1 notifications and
            // v2's `notify`. `notifications/progress` is servable; `notifications/message` is not,
            // because the stateless unit declares no `logging` capability — v2 throws on it, and a
            // relayed notification must never fail the tool call.
            const softFails = captureSoftFails();
            const proxiedResult = { content: [{ type: 'text', text: 'proxied ok' }] };
            vi.spyOn(mcpClient, 'connectMCPClient').mockResolvedValue(
                stubNotifyingClient(
                    [
                        { method: 'notifications/progress', params: { progressToken: 'p1', progress: 1 } },
                        { method: 'notifications/message', params: { level: 'info', data: 'remote chatter' } },
                    ],
                    proxiedResult,
                ) as never,
            );

            await withStatelessServer(async ({ server, call }) => {
                await loadSource(server, [makeActorMcpTool()]);

                const response = await call(
                    'tools/call',
                    { name: 'test-actor-mcp-tool', arguments: {} },
                    // Dispatch only wires notification forwarding when the request carries a token.
                    { meta: { progressToken: 'p1' } },
                );

                expect(response.error).toBeUndefined();
                expect(response.result).toMatchObject(proxiedResult);
                const dropped = softFailsStartingWith(softFails, 'Dropped an outbound notification');
                expect(dropped).toHaveLength(1);
                expect(dropped[0][1]).toMatchObject({ method: 'notifications/message' });
            });
        });

        it('reports an Actor-MCP connect failure server-side, with nothing sent on the wire', async () => {
            // The engine's `emitLog` side channel has no client-visible destination here (no
            // `logging` capability, so no `notifications/message`); it must land in the process log
            // while the same text still reaches the client in the result body.
            const softFails = captureSoftFails();
            vi.spyOn(mcpClient, 'connectMCPClient').mockResolvedValue(null);

            await withStatelessServer(async ({ server, call }) => {
                await loadSource(server, [makeActorMcpTool()]);

                const response = await call('tools/call', { name: 'test-actor-mcp-tool', arguments: {} });

                const content = (response.result?.content ?? []) as { text: string }[];
                expect(response.result?.isError).toBe(true);
                expect(content[0].text).toContain('Failed to connect to MCP server');
                const emitted = softFailsStartingWith(softFails, 'Tool call reported a failure');
                expect(emitted).toHaveLength(1);
                expect(emitted[0][1]).toMatchObject({ level: 'error' });
                expect(String(emitted[0][1]?.errMessage)).toContain('Failed to connect to MCP server');
            });
        });
    });
});
