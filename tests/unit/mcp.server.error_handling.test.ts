import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import log from '@apify/log';

import { TOOL_STATUS } from '../../src/const.js';
import { ActorsMcpServer } from '../../src/mcp/server.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../src/types.js';
import { TOOL_TYPE } from '../../src/types.js';
import { compileSchema } from '../../src/utils/ajv.js';
import { getToolCallErrorUserText } from '../../src/utils/mcp.js';

/**
 * Covers the `server.onerror` wiring in `setupErrorHandling()`: client faults softFail with a
 * Mezmo-sanitized message, anything else logs at error level. The fault patterns themselves
 * are covered by the `isMcpClientFaultMessage()` tests in utils.logging.test.ts.
 */
describe('ActorsMcpServer onerror', () => {
    afterEach(() => vi.restoreAllMocks());

    it('soft-fails client faults with a sanitized message and error-logs the rest', async () => {
        const server = new ActorsMcpServer({
            taskStore: new InMemoryTaskStore(),
            setupSigintHandler: false,
            telemetry: { enabled: false },
            token: 'fake-token',
        });
        try {
            const softFail = vi.spyOn(log, 'softFail').mockImplementation(() => log);
            const errorLog = vi.spyOn(log, 'error').mockImplementation(() => log);

            server.server.onerror?.(new Error('Parse error: Invalid JSON-RPC message'));
            expect(errorLog).not.toHaveBeenCalled();
            expect(softFail).toHaveBeenCalledWith('MCP client fault, request could not be handled', {
                errMessage: 'Parse failure: Invalid JSON-RPC message',
            });

            server.server.onerror?.(new Error('Unexpected internal failure'));
            expect(errorLog).toHaveBeenCalledTimes(1);
        } finally {
            await server.close();
        }
    });
});

/**
 * Covers the tool-dispatch outer `catch` in the `CallToolRequestSchema` handler (server.ts).
 * That response never passes through `extractToolTelemetry`, so `captureResult` is what strips the
 * server-internal `toolTelemetry` field from it (#1052) — nothing of it may reach the client.
 *
 * The pre-computed, ABORTED-aware `toolStatus` is still reported to telemetry from the handler's
 * local state, so stripping the field costs no classification accuracy.
 */
describe('CallToolRequestSchema handler outer catch', () => {
    type HandlerFn = (req: Record<string, unknown>, extra: Record<string, unknown>) => Promise<Record<string, unknown>>;
    type TelemetryArgs = { toolStatus: string; callDiagnostics: Record<string, unknown> };

    // A synthetic internal tool whose call throws a plain (non-McpError) error, so dispatch falls
    // through to the outer catch. An empty input schema validates against `{}`.
    function makeThrowingTool(): ToolEntry {
        return {
            type: TOOL_TYPE.INTERNAL,
            name: 'test-throwing-tool',
            description: 'throws',
            inputSchema: { type: 'object', properties: {} } as ToolInputSchema,
            ajvValidate: compileSchema({ type: 'object', properties: {} }),
            call: async (_toolArgs: InternalToolArgs) => {
                throw new Error('boom');
            },
        };
    }

    function getToolCallHandler(server: ActorsMcpServer): HandlerFn {
        // eslint-disable-next-line no-underscore-dangle
        const handler = (
            server as unknown as { server: { _requestHandlers: Map<string, HandlerFn> } }
        ).server._requestHandlers.get('tools/call');
        if (!handler) throw new Error('tools/call handler not registered');
        return handler;
    }

    async function dispatchThrow(aborted: boolean) {
        const server = new ActorsMcpServer({
            taskStore: new InMemoryTaskStore(),
            setupSigintHandler: false,
            telemetry: { enabled: false },
            token: 'fake-token',
        });
        // The handler reports the outcome to telemetry from its own local state, not from the
        // response — spy on it so we can assert the classification survives the strip.
        const telemetrySpy = vi.spyOn(
            server as unknown as { logToolCallAndTelemetry: (args: TelemetryArgs) => void },
            'logToolCallAndTelemetry',
        );
        try {
            vi.spyOn(log, 'error').mockImplementation(() => log);
            vi.spyOn(log, 'exception').mockImplementation(() => log);
            server.upsertTools([makeThrowingTool()]);
            const handler = getToolCallHandler(server);
            const result = await handler(
                {
                    method: 'tools/call',
                    params: { name: 'test-throwing-tool', arguments: {}, _meta: { mcpSessionId: 's1' } },
                },
                { signal: { aborted }, sendNotification: vi.fn() },
            );
            return { result, reportedToolStatus: telemetrySpy.mock.calls[0]?.[0]?.toolStatus };
        } finally {
            await server.close();
        }
    }

    it('strips toolTelemetry from the response and still reports ABORTED when the request was aborted', async () => {
        const { result, reportedToolStatus } = await dispatchThrow(true);

        expect(result.isError).toBe(true);
        expect(result.content).toEqual([
            { type: 'text', text: getToolCallErrorUserText('test-throwing-tool', new Error('boom')) },
        ]);
        // Server-internal field — must not survive onto the wire.
        expect(result).not.toHaveProperty('toolTelemetry');
        // ...but the ABORTED-aware classification still reaches telemetry.
        expect(reportedToolStatus).toBe(TOOL_STATUS.ABORTED);
    });

    it('strips toolTelemetry from the response and still reports FAILED when the request was not aborted', async () => {
        const { result, reportedToolStatus } = await dispatchThrow(false);

        expect(result.isError).toBe(true);
        expect(result).not.toHaveProperty('toolTelemetry');
        expect(reportedToolStatus).toBe(TOOL_STATUS.FAILED);
    });
});

/**
 * Wire-level guard for the outer catch: `CallToolResultSchema` is a `z.looseObject`, so any key left
 * on the response object is forwarded verbatim to the client. `toolTelemetry` is server-internal and
 * must never reach the wire on any path — including the paths that bypass `extractToolTelemetry()`.
 */
describe('CallToolRequestSchema handler wire shape', () => {
    function makeThrowingTool(): ToolEntry {
        return {
            type: TOOL_TYPE.INTERNAL,
            name: 'test-throwing-tool',
            description: 'throws',
            inputSchema: { type: 'object', properties: {} } as ToolInputSchema,
            ajvValidate: compileSchema({ type: 'object', properties: {} }),
            call: async (_toolArgs: InternalToolArgs) => {
                throw new Error('boom');
            },
        };
    }

    it('does not leak toolTelemetry to the client when an internal tool throws', async () => {
        const server = new ActorsMcpServer({
            taskStore: new InMemoryTaskStore(),
            setupSigintHandler: false,
            telemetry: { enabled: false },
            token: 'fake-token',
        });
        const client = new Client({ name: 'wire-client', version: '0.0.0' });
        try {
            vi.spyOn(log, 'error').mockImplementation(() => log);
            vi.spyOn(log, 'exception').mockImplementation(() => log);
            server.upsertTools([makeThrowingTool()]);

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            await Promise.all([client.connect(clientTransport), server.server.connect(serverTransport)]);

            const result = await client.callTool({
                name: 'test-throwing-tool',
                arguments: {},
                _meta: { mcpSessionId: 'wire-1' },
            });

            expect(result.isError).toBe(true);
            expect(result).not.toHaveProperty('toolTelemetry');
        } finally {
            await client.close();
            await server.close();
        }
    });
});
