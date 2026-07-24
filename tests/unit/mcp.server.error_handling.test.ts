import { Readable } from 'node:stream';

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
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

/**
 * Wire oracle for the domain-error → McpError boundary in `setupResourceHandlers`/`setupPromptHandlers`:
 * the services throw protocol-neutral domain errors, and the handler must surface them as `McpError`
 * carrying the original code, message, and `data` unchanged.
 */
describe('resources/read and prompts/get error boundary', () => {
    it('surfaces a resources/read failure as McpError(InvalidParams) with the uri in data', async () => {
        await withServer(async (server) => {
            const handler = getRequestHandler(server, 'resources/read');

            const error = await handler(
                { method: 'resources/read', params: { uri: 'file://missing.md' } },
                { signal: { aborted: false }, sendNotification: vi.fn() },
            ).catch((e: unknown) => e);

            expect(error).toBeInstanceOf(McpError);
            expect((error as McpError).code).toBe(ErrorCode.InvalidParams);
            expect((error as McpError).message).toContain('file://missing.md');
            expect((error as McpError).data).toEqual({ uri: 'file://missing.md' });
        });
    });

    it('surfaces a resources/read 5xx as McpError(InternalError) — not downgraded to InvalidParams', async () => {
        await withServer(async (server) => {
            const uri = 'https://api.apify.com/v2/datasets/ds-1/items';
            const stubClient = {
                httpClient: {
                    axios: {
                        request: async () => ({
                            data: Readable.from([]),
                            headers: { 'content-type': 'application/json' },
                            status: 500,
                            statusText: 'Internal Server Error',
                        }),
                    },
                },
            };
            // The handler builds its own token-scoped client; stub it so the read resolves a 5xx,
            // driving readApiResource down the InternalError arm through the real resources/read seam.
            vi.spyOn(server as unknown as { resolveApifyClient: () => unknown }, 'resolveApifyClient').mockReturnValue(
                stubClient,
            );
            const handler = getRequestHandler(server, 'resources/read');

            const error = await handler(
                { method: 'resources/read', params: { uri } },
                { signal: { aborted: false }, sendNotification: vi.fn() },
            ).catch((e: unknown) => e);

            expect(error).toBeInstanceOf(McpError);
            expect((error as McpError).code).toBe(ErrorCode.InternalError);
            expect((error as McpError).message).toContain('HTTP 500');
            expect((error as McpError).data).toEqual({ uri });
        });
    });

    it('surfaces a prompts/get failure for an unknown name as McpError(InvalidParams)', async () => {
        await withServer(async (server) => {
            const handler = getRequestHandler(server, 'prompts/get');

            const error = await handler(
                { method: 'prompts/get', params: { name: 'nonexistent' } },
                { signal: { aborted: false }, sendNotification: vi.fn() },
            ).catch((e: unknown) => e);

            expect(error).toBeInstanceOf(McpError);
            expect((error as McpError).code).toBe(ErrorCode.InvalidParams);
            expect((error as McpError).message).toContain('nonexistent');
            expect((error as McpError).message).toContain('Available prompts:');
        });
    });
});
