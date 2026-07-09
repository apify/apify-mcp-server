import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
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
 * That response is returned via `captureResult` and never passes through `extractToolTelemetry`,
 * so it must preserve the pre-computed, ABORTED-aware `toolStatus` and emit only `{ toolStatus }`
 * in `toolTelemetry` — no `failureCategory`/`failureHttpStatus` (which would leak onto the wire).
 */
describe('CallToolRequestSchema handler outer catch', () => {
    type HandlerFn = (req: Record<string, unknown>, extra: Record<string, unknown>) => Promise<Record<string, unknown>>;

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
        try {
            vi.spyOn(log, 'error').mockImplementation(() => log);
            vi.spyOn(log, 'exception').mockImplementation(() => log);
            server.upsertTools([makeThrowingTool()]);
            const handler = getToolCallHandler(server);
            return await handler(
                {
                    method: 'tools/call',
                    params: { name: 'test-throwing-tool', arguments: {}, _meta: { mcpSessionId: 's1' } },
                },
                { signal: { aborted }, sendNotification: vi.fn() },
            );
        } finally {
            await server.close();
        }
    }

    it('preserves ABORTED toolStatus and emits only { toolStatus } when the request was aborted', async () => {
        const result = await dispatchThrow(true);

        expect(result.isError).toBe(true);
        expect(result.content).toEqual([
            { type: 'text', text: getToolCallErrorUserText('test-throwing-tool', new Error('boom')) },
        ]);
        // Only toolStatus — no failureCategory/failureHttpStatus leaking onto the wire.
        expect(result.toolTelemetry).toEqual({ toolStatus: TOOL_STATUS.ABORTED });
    });

    it('emits only { toolStatus } (derived FAILED) when the request was not aborted', async () => {
        const result = await dispatchThrow(false);

        expect(result.isError).toBe(true);
        expect(result.toolTelemetry).toEqual({ toolStatus: TOOL_STATUS.FAILED });
    });
});
