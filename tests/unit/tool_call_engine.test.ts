import { afterEach, describe, expect, it, vi } from 'vitest';

import log from '@apify/log';

import { FAILURE_CATEGORY, TOOL_STATUS } from '../../src/const.js';
import type { ActorsMcpServer } from '../../src/mcp/server.js';
import type { InvalidToolCall, PreparedCall } from '../../src/mcp/tool_call_engine.js';
import { executeSyncToolCall, prepareToolCall } from '../../src/mcp/tool_call_engine.js';
import type { ToolCallTelemetryProperties } from '../../src/types.js';
import { makePaymentRequiredError, makeRecorderTool, makeThrowingTool, withServer } from './helpers/mcp_server.js';

/** An abort signal for direct engine tests, optionally already aborted. */
function makeSignal(aborted = false): AbortSignal {
    const controller = new AbortController();
    if (aborted) controller.abort();
    return controller.signal;
}

/** Server-derived plain values that `prepareToolCall` reads. */
function prepareFields(server: ActorsMcpServer) {
    return {
        tools: server.tools,
        paymentProvider: server.options.paymentProvider,
        allowUnauthMode: server.options.allowUnauthMode,
    };
}

/** Suppresses expected failure logs. */
function silenceLogs(): void {
    vi.spyOn(log, 'error').mockImplementation(() => log);
    vi.spyOn(log, 'exception').mockImplementation(() => log);
    vi.spyOn(log, 'softFail').mockImplementation(() => log);
    vi.spyOn(log, 'warning').mockImplementation(() => log);
}

describe('prepareToolCall()', () => {
    afterEach(() => vi.restoreAllMocks());

    it('returns InvalidToolCall with AUTH category when no token is provided', async () => {
        await withServer(async (server) => {
            const result = await prepareToolCall({
                ...prepareFields(server),
                apifyToken: '',
                name: 'anything',
                args: {},
                meta: undefined,
                requestHeaders: undefined,
                isTaskRequest: false,
                mcpSessionId: 's1',
                telemetryData: null,
                clientContext: undefined,
            });
            expect('message' in result).toBe(true);
            const invalid = result as InvalidToolCall;
            expect(invalid.toolStatus).toBe(TOOL_STATUS.SOFT_FAIL);
            expect(invalid.callDiagnostics.failure_category).toBe(FAILURE_CATEGORY.AUTH);
            expect(invalid.message).toContain('Apify API token is required');
        });
    });

    it('returns InvalidToolCall for an unknown tool name', async () => {
        await withServer(async (server) => {
            const result = await prepareToolCall({
                ...prepareFields(server),
                apifyToken: 'fake-token',
                name: 'does-not-exist',
                args: {},
                meta: undefined,
                requestHeaders: undefined,
                isTaskRequest: false,
                mcpSessionId: 's1',
                telemetryData: null,
                clientContext: undefined,
            });
            expect('message' in result).toBe(true);
            const invalid = result as InvalidToolCall;
            expect(invalid.callDiagnostics.failure_category).toBe(FAILURE_CATEGORY.INVALID_INPUT);
            expect(invalid.message).toContain('was not found');
        });
    });

    it('returns InvalidToolCall for missing arguments', async () => {
        await withServer(async (server) => {
            const { tool } = makeRecorderTool('recorder-tool');
            server.upsertTools([tool]);
            const result = await prepareToolCall({
                ...prepareFields(server),
                apifyToken: 'fake-token',
                name: 'recorder-tool',
                args: undefined,
                meta: undefined,
                requestHeaders: undefined,
                isTaskRequest: false,
                mcpSessionId: 's1',
                telemetryData: null,
                clientContext: undefined,
            });
            expect('message' in result).toBe(true);
            const invalid = result as InvalidToolCall;
            expect(invalid.message).toContain('Missing arguments');
        });
    });

    it('returns a PreparedCall and updates telemetry tool_name for a valid call', async () => {
        await withServer(async (server) => {
            const { tool } = makeRecorderTool('recorder-tool');
            server.upsertTools([tool]);
            const telemetryData = { tool_name: 'recorder-tool' } as unknown as ToolCallTelemetryProperties;
            const result = await prepareToolCall({
                ...prepareFields(server),
                apifyToken: 'fake-token',
                name: 'recorder-tool',
                args: {},
                meta: undefined,
                requestHeaders: undefined,
                isTaskRequest: false,
                mcpSessionId: 's1',
                telemetryData,
                clientContext: undefined,
            });
            expect('message' in result).toBe(false);
            const prepared = result as PreparedCall;
            expect(prepared.tool.name).toBe('recorder-tool');
            expect(prepared.standbyRejection).toBeNull();
            expect(prepared.paymentRequiredResult).toBeUndefined();
            expect(telemetryData.tool_name).toBe('recorder-tool');
        });
    });
});

describe('executeSyncToolCall()', () => {
    afterEach(() => vi.restoreAllMocks());

    async function prepare(server: ActorsMcpServer, name: string, tool: unknown) {
        server.upsertTools([tool as never]);
        const prepared = (await prepareToolCall({
            ...prepareFields(server),
            apifyToken: 'fake-token',
            name,
            args: {},
            meta: undefined,
            requestHeaders: undefined,
            isTaskRequest: false,
            mcpSessionId: 's1',
            telemetryData: null,
            clientContext: undefined,
        })) as PreparedCall;
        return prepared;
    }

    /** Server-derived plain values that `executeSyncToolCall` reads. */
    function syncParams(server: ActorsMcpServer, toolName: string, aborted = false) {
        return {
            apifyToken: 'fake-token',
            toolName,
            mcpSessionId: 's1',
            progressToken: undefined,
            tools: server.tools,
            actorStore: server.actorStore,
            paymentProvider: server.options.paymentProvider,
            signal: makeSignal(aborted),
            sendNotification: vi.fn(),
            emitLog: vi.fn(),
        };
    }

    it('returns a success outcome for a normal dispatch', async () => {
        await withServer(async (server) => {
            const { tool } = makeRecorderTool('recorder-tool');
            const prepared = await prepare(server, 'recorder-tool', tool);
            const outcome = await executeSyncToolCall(prepared, syncParams(server, 'recorder-tool'));
            expect(outcome.toolStatus).toBe(TOOL_STATUS.SUCCEEDED);
            expect((outcome.result.content as { text: string }[])[0].text).toBe('ok');
        });
    });

    it('classifies a 402 dispatch error as a payment outcome', async () => {
        await withServer(async (server) => {
            silenceLogs();
            const tool = makeThrowingTool({ name: 'payment-throwing-tool', error: makePaymentRequiredError() });
            const prepared = await prepare(server, 'payment-throwing-tool', tool);
            const outcome = await executeSyncToolCall(prepared, syncParams(server, 'payment-throwing-tool'));
            expect(outcome.toolStatus).toBe(TOOL_STATUS.SOFT_FAIL);
            expect(outcome.callDiagnostics.failure_http_status).toBe(402);
            expect(outcome.result.isError).toBe(true);
        });
    });

    it('reports ABORTED status when the signal is aborted', async () => {
        await withServer(async (server) => {
            silenceLogs();
            const tool = makeThrowingTool({ name: 'aborting-tool', error: new Error('boom') });
            const prepared = await prepare(server, 'aborting-tool', tool);
            const outcome = await executeSyncToolCall(prepared, syncParams(server, 'aborting-tool', true));
            expect(outcome.toolStatus).toBe(TOOL_STATUS.ABORTED);
            expect(outcome.result.isError).toBe(true);
            expect(outcome.result.toolTelemetry).toEqual({ toolStatus: TOOL_STATUS.ABORTED });
        });
    });
});
