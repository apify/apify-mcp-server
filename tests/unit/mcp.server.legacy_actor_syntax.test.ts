import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApifyClient } from '../../src/apify_client.js';
import { HELPER_TOOLS } from '../../src/const.js';
import { callActor } from '../../src/tools/actors/call_actor.js';
import { callActorMcpTool } from '../../src/tools/actors/call_actor_mcp_tool.js';
import { callActorWidget } from '../../src/tools/widgets/call_actor_widget.js';
import { getRequestHandler, makePaymentProvider, withServer } from './helpers/mcp_server.js';

afterEach(() => vi.restoreAllMocks());

describe('legacy Actor MCP syntax rejection', () => {
    it.each([
        { tool: callActor },
        { tool: callActorWidget },
        { tool: callActor, paymentProvider: makePaymentProvider('skyfire'), token: '' },
        { tool: callActorWidget, paymentProvider: makePaymentProvider('skyfire'), token: '' },
        { tool: callActor, paymentProvider: makePaymentProvider('skyfire'), token: 'test-token' },
        { tool: callActorWidget, paymentProvider: makePaymentProvider('skyfire'), token: 'test-token' },
        { tool: callActor, paymentProvider: makePaymentProvider('x402'), token: '' },
        { tool: callActorWidget, paymentProvider: makePaymentProvider('x402'), token: '' },
        { tool: callActor, paymentProvider: makePaymentProvider('x402'), token: 'test-token' },
        { tool: callActorWidget, paymentProvider: makePaymentProvider('x402'), token: 'test-token' },
    ])(
        'rejects $tool.name before metadata lookup with $paymentProvider.id and token "$token"',
        async ({ tool, ...options }) => {
            const lookup = vi.spyOn(ApifyClient.prototype, 'actor').mockImplementation(() => {
                throw new Error('Actor metadata unavailable');
            });

            await withServer(async (server) => {
                server.upsertTools(options.paymentProvider ? [tool] : [tool, callActorMcpTool]);
                const result = await getRequestHandler(server, 'tools/call')(
                    {
                        method: 'tools/call',
                        params: {
                            name: tool.name,
                            arguments: { actor: 'apify/example-mcp-server:add', input: {} },
                            _meta: { mcpSessionId: 'legacy-syntax' },
                        },
                    },
                    { signal: new AbortController().signal, sendNotification: vi.fn() },
                );

                expect(result.isError).toBe(true);
                expect(JSON.stringify(result.content)).toContain('no longer supported');
                expect(JSON.stringify(result.content).includes(HELPER_TOOLS.ACTOR_MCP_TOOL_CALL)).toBe(
                    !options.paymentProvider,
                );
                expect(result).not.toHaveProperty('toolTelemetry');
                expect(lookup).not.toHaveBeenCalled();
            }, options);
        },
    );

    it('omits an unavailable replacement and gives a configuration remedy', async () => {
        vi.spyOn(ApifyClient.prototype, 'actor').mockImplementation(() => {
            throw new Error('Actor metadata unavailable');
        });
        await withServer(async (server) => {
            server.upsertTools([callActor]);
            const result = await getRequestHandler(server, 'tools/call')(
                {
                    method: 'tools/call',
                    params: {
                        name: callActor.name,
                        arguments: { actor: 'apify/example-mcp-server:add', input: {} },
                        _meta: { mcpSessionId: 'legacy-syntax' },
                    },
                },
                { signal: new AbortController().signal, sendNotification: vi.fn() },
            );

            expect(result.isError).toBe(true);
            expect(JSON.stringify(result.content)).not.toContain(HELPER_TOOLS.ACTOR_MCP_TOOL_CALL);
            expect(JSON.stringify(result.content)).toContain('configuration');
        });
    });
});
