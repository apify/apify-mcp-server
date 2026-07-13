import { afterEach, describe, expect, it, vi } from 'vitest';

import log from '@apify/log';

import { TOOL_STATUS } from '../../src/const.js';
import { getToolCallErrorUserText } from '../../src/utils/mcp.js';
import { getRequestHandler, makeThrowingTool, withServer } from './helpers/mcp_server.js';

/**
 * Covers the `server.onerror` wiring in `setupErrorHandling()`: client faults softFail with a
 * Mezmo-sanitized message, anything else logs at error level. The fault patterns themselves
 * are covered by the `isMcpClientFaultMessage()` tests in utils.logging.test.ts.
 */
describe('ActorsMcpServer onerror', () => {
    afterEach(() => vi.restoreAllMocks());

    it('soft-fails client faults with a sanitized message and error-logs the rest', async () => {
        await withServer(async (server) => {
            const softFail = vi.spyOn(log, 'softFail').mockImplementation(() => log);
            const errorLog = vi.spyOn(log, 'error').mockImplementation(() => log);

            server.server.onerror?.(new Error('Parse error: Invalid JSON-RPC message'));
            expect(errorLog).not.toHaveBeenCalled();
            expect(softFail).toHaveBeenCalledWith('MCP client fault, request could not be handled', {
                errMessage: 'Parse failure: Invalid JSON-RPC message',
            });

            server.server.onerror?.(new Error('Unexpected internal failure'));
            expect(errorLog).toHaveBeenCalledTimes(1);
        });
    });
});

/**
 * Covers the tool-dispatch outer `catch` in the `CallToolRequestSchema` handler (server.ts).
 * That response is returned via `captureResult` and never passes through `extractToolTelemetry`,
 * so it must preserve the pre-computed, ABORTED-aware `toolStatus` and emit only `{ toolStatus }`
 * in `toolTelemetry` — no `failureCategory`/`failureHttpStatus` (which would leak onto the wire).
 */
describe('CallToolRequestSchema handler outer catch', () => {
    async function dispatchThrow(aborted: boolean) {
        return withServer(async (server) => {
            vi.spyOn(log, 'error').mockImplementation(() => log);
            vi.spyOn(log, 'exception').mockImplementation(() => log);
            server.upsertTools([makeThrowingTool()]);
            const handler = getRequestHandler(server, 'tools/call');
            return handler(
                {
                    method: 'tools/call',
                    params: { name: 'test-throwing-tool', arguments: {}, _meta: { mcpSessionId: 's1' } },
                },
                { signal: { aborted }, sendNotification: vi.fn() },
            );
        });
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
