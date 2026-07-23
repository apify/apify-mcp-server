import type { ServerContext } from '@modelcontextprotocol/server';
import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    PROTOCOL_VERSION_META_KEY,
    ProtocolError,
} from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { createModernServer } from '../../src/mcp/modern_server.js';
import { RESOURCE_MIME_TYPE } from '../../src/resources/widgets.js';
import { reportProblem } from '../../src/tools/dev/report_problem.js';
import type { InternalToolArgs, ToolEntry } from '../../src/types.js';
import { SERVER_MODE, TOOL_TYPE } from '../../src/types.js';
import { respondRaw } from '../../src/utils/mcp.js';
import { withServer } from './helpers/mcp_server.js';

const MODERN_PROTOCOL_VERSION = '2026-07-28';

type ModernHandlerFn = (req: Record<string, unknown>, ctx: ServerContext) => Promise<Record<string, unknown>>;

/**
 * Returns the request handler the v2 SDK registered for `method`, reached through the modern
 * server's private `_requestHandlers` map (same seam as `getRequestHandler` for the v1 server,
 * restated here because the modern server IS the protocol instance — no `.server` hop).
 */
function getModernRequestHandler(modernServer: unknown, method: string): ModernHandlerFn {
    // eslint-disable-next-line no-underscore-dangle
    const handler = (modernServer as { _requestHandlers: Map<string, ModernHandlerFn> })._requestHandlers.get(method);
    if (!handler) throw new Error(`Handler "${method}" not registered`);
    return handler;
}

function listModernHandlerMethods(modernServer: unknown): string[] {
    // eslint-disable-next-line no-underscore-dangle
    return Array.from((modernServer as { _requestHandlers: Map<string, ModernHandlerFn> })._requestHandlers.keys());
}

/**
 * Fabricated per-request v2 handler context: the envelope carries the reserved
 * `io.modelcontextprotocol/*` keys exactly as the SDK's lift surfaces them, and `authInfo`
 * stands in for the hosting layer's validated-token pass-through.
 */
function makeModernCtx(
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

/** An INTERNAL tool that echoes the Apify token the dispatcher resolved for the call. */
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

describe('createModernServer()', () => {
    describe('registration surface', () => {
        it('registers the four modern surfaces and no tasks handlers', async () => {
            await withServer(async (server) => {
                const modern = createModernServer(server);
                const methods = listModernHandlerMethods(modern);
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
    });

    describe('tools/list', () => {
        it('lists the tools of the backing ActorsMcpServer', async () => {
            await withServer(async (server) => {
                server.upsertTools([makeTokenEchoTool()]);
                const modern = createModernServer(server);
                const handler = getModernRequestHandler(modern, 'tools/list');
                const result = await handler({ method: 'tools/list', params: {} }, makeModernCtx());
                const names = (result.tools as { name: string }[]).map((t) => t.name);
                expect(names).toContain('token-echo-tool');
            });
        });

        it('withholds report-problem when the request carries no clientInfo', async () => {
            await withServer(
                async (server) => {
                    // Shallow copy: the registry entry is frozen, and close() nulls ajvValidate.
                    server.upsertTools([{ ...reportProblem }]);
                    const modern = createModernServer(server);
                    const handler = getModernRequestHandler(modern, 'tools/list');

                    const unknownClient = await handler({ method: 'tools/list', params: {} }, makeModernCtx());
                    const unknownNames = (unknownClient.tools as { name: string }[]).map((t) => t.name);
                    expect(unknownNames).not.toContain(HELPER_TOOLS.PROBLEM_REPORT);

                    const knownClient = await handler(
                        { method: 'tools/list', params: {} },
                        makeModernCtx({ clientInfo: { name: 'test-client', version: '1.0.0' } }),
                    );
                    const knownNames = (knownClient.tools as { name: string }[]).map((t) => t.name);
                    expect(knownNames).toContain(HELPER_TOOLS.PROBLEM_REPORT);
                },
                { telemetry: { enabled: true } },
            );
        });
    });

    describe('tools/call', () => {
        it('resolves the Apify token from ctx.http.authInfo.token over the instance option', async () => {
            await withServer(async (server) => {
                server.upsertTools([makeTokenEchoTool()]);
                const modern = createModernServer(server);
                const handler = getModernRequestHandler(modern, 'tools/call');
                const result = await handler(
                    { method: 'tools/call', params: { name: 'token-echo-tool', arguments: {} } },
                    makeModernCtx({ authToken: 'auth-info-token' }),
                );
                const content = result.content as { type: string; text: string }[];
                expect(content[0].text).toBe('auth-info-token');
            });
        });

        it('falls back to the instance token when the request carries no authInfo', async () => {
            await withServer(async (server) => {
                server.upsertTools([makeTokenEchoTool()]);
                const modern = createModernServer(server);
                const handler = getModernRequestHandler(modern, 'tools/call');
                const result = await handler(
                    { method: 'tools/call', params: { name: 'token-echo-tool', arguments: {} } },
                    makeModernCtx(),
                );
                const content = result.content as { type: string; text: string }[];
                expect(content[0].text).toBe('fake-token');
            });
        });

        it('rejects an unknown tool with an InvalidParams protocol error', async () => {
            await withServer(async (server) => {
                const modern = createModernServer(server);
                const handler = getModernRequestHandler(modern, 'tools/call');
                await expect(
                    handler({ method: 'tools/call', params: { name: 'no-such-tool', arguments: {} } }, makeModernCtx()),
                ).rejects.toThrow(ProtocolError);
            });
        });

        it('rejects when no token is resolvable and unauthenticated mode is off', async () => {
            await withServer(
                async (server) => {
                    server.upsertTools([makeTokenEchoTool()]);
                    const modern = createModernServer(server);
                    const handler = getModernRequestHandler(modern, 'tools/call');
                    await expect(
                        handler(
                            { method: 'tools/call', params: { name: 'token-echo-tool', arguments: {} } },
                            makeModernCtx(),
                        ),
                    ).rejects.toThrow(/Apify API token is required/);
                },
                { token: undefined },
            );
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
    });

    describe('prompts', () => {
        it('lists prompts and rejects an unknown prompt name', async () => {
            await withServer(async (server) => {
                const modern = createModernServer(server);
                const list = await getModernRequestHandler(modern, 'prompts/list')(
                    { method: 'prompts/list', params: {} },
                    makeModernCtx(),
                );
                expect(Array.isArray(list.prompts)).toBe(true);
                await expect(
                    getModernRequestHandler(modern, 'prompts/get')(
                        { method: 'prompts/get', params: { name: 'no-such-prompt' } },
                        makeModernCtx(),
                    ),
                ).rejects.toThrow(ProtocolError);
            });
        });
    });

    describe('prepare()', () => {
        it('runs before the transport connects in connect()', async () => {
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
