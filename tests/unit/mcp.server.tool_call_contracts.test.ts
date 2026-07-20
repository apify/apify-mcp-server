import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import log from '@apify/log';

import { FAILURE_CATEGORY, HELPER_TOOLS, TOOL_STATUS } from '../../src/const.js';
import type { ActorsMcpServer } from '../../src/mcp/server.js';
import type { PaymentProvider } from '../../src/payments/types.js';
import * as telemetry from '../../src/telemetry.js';
import * as callActor from '../../src/tools/actors/call_actor.js';
import type { ToolEntry, ToolInputSchema } from '../../src/types.js';
import { TOOL_TYPE } from '../../src/types.js';
import { compileSchema } from '../../src/utils/ajv.js';
import {
    getRequestHandler,
    makePaymentRequiredError,
    makePermissionApprovalError,
    makeRecorderTool,
    makeThrowingTool,
    PERMISSION_HTTP_STATUS,
    withServer,
    X402_PAYMENT_DATA,
} from './helpers/mcp_server.js';

/**
 * Pins the handler-level behavior contracts for the two catch paths (the sync
 * `CallToolRequestSchema` catch and the `executeToolAndUpdateTask` catch). Both catches now share
 * error classification via `buildToolCallErrorResult`; #658 will still unify the two sinks
 * themselves. Failure classes are fabricated by throwing from a fake tool's `call`; both the sync
 * path (result shapes) and the task path (terminal status mapping) assert the same source-of-truth
 * per class.
 */

/** The wire `content` `buildPaymentRequiredResponse` produces for X402_PAYMENT_DATA. */
const X402_RESPONSE_CONTENT = [
    { type: 'text', text: JSON.stringify(X402_PAYMENT_DATA) },
    { type: 'text', text: 'Payment required to run this Actor or access this resource.' },
];

type FailureClass = {
    label: string;
    makeError: () => unknown;
    taskStatus: 'completed' | 'failed';
    /** Exact stored task-store payload — deep-equal pin, so any added/dropped key fails. */
    storedResult: Record<string, unknown>;
    telemetry: { tool_status: string; failure_category: string; failure_http_status?: number };
    /** Failure-class keys expected on top of BASE_TELEMETRY_KEYS (exact-key-set pin). */
    telemetryExtraKeys: string[];
};

const FAILURE_CLASSES: FailureClass[] = [
    {
        label: '402 payment-required',
        makeError: () => makePaymentRequiredError(X402_PAYMENT_DATA),
        taskStatus: 'completed',
        storedResult: { content: X402_RESPONSE_CONTENT, isError: true, structuredContent: X402_PAYMENT_DATA },
        telemetry: {
            tool_status: TOOL_STATUS.SOFT_FAIL,
            failure_category: FAILURE_CATEGORY.INVALID_INPUT,
            failure_http_status: 402,
        },
        telemetryExtraKeys: ['failure_category', 'failure_http_status'],
    },
    {
        label: 'permission-approval',
        makeError: makePermissionApprovalError,
        taskStatus: 'completed',
        storedResult: { content: [{ type: 'text', text: 'needs approval' }], isError: true },
        telemetry: {
            tool_status: TOOL_STATUS.SOFT_FAIL,
            failure_category: FAILURE_CATEGORY.PERMISSION_APPROVAL_REQUIRED,
            failure_http_status: PERMISSION_HTTP_STATUS,
        },
        telemetryExtraKeys: ['failure_category', 'failure_http_status'],
    },
    {
        label: 'generic execution error',
        makeError: () => new Error('boom'),
        taskStatus: 'failed',
        storedResult: {
            content: [
                {
                    type: 'text',
                    text: 'Error calling tool "test-throwing-tool": boom. Verify the tool name and input parameters.',
                },
            ],
            isError: true,
            internalToolStatus: TOOL_STATUS.FAILED,
        },
        telemetry: {
            tool_status: TOOL_STATUS.FAILED,
            failure_category: FAILURE_CATEGORY.INTERNAL_ERROR,
        },
        telemetryExtraKeys: ['failure_category', 'failure_detail'],
    },
];

/**
 * Keys `prepareTelemetryData` + the handler `finally` finalization put on every tool-call Segment
 * event, sync and task paths alike — pinned empirically. This suite is the only CI guard for these
 * shapes (dashboards consume them; the internal repo does not), so the pin is an exact key set: a
 * key appearing or disappearing must be a conscious edit here.
 */
const BASE_TELEMETRY_KEYS = [
    'app',
    'app_version',
    'mcp_client_capabilities',
    'mcp_client_name',
    'mcp_client_version',
    'mcp_protocol_version',
    'mcp_session_id',
    'tool_exec_time_ms',
    'tool_name',
    'tool_response_content_bytes',
    'tool_response_file_bytes',
    'tool_response_structured_content_bytes',
    'tool_status',
    'transport_type',
];

/** Silence the error-path logging the failure branches emit, keeping test output clean. */
function silenceLogs(): void {
    vi.spyOn(log, 'error').mockImplementation(() => log);
    vi.spyOn(log, 'exception').mockImplementation(() => log);
    vi.spyOn(log, 'softFail').mockImplementation(() => log);
    vi.spyOn(log, 'warning').mockImplementation(() => log);
}

/** An ACTOR_MCP tool with `taskSupport` forced so it clears the pre-dispatch gate (see the gap test). */
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
        execution: { taskSupport: 'optional' },
    } as ToolEntry;
}

async function runSync(server: ActorsMcpServer, tool: ToolEntry): Promise<Record<string, unknown>> {
    server.upsertTools([tool]);
    const handler = getRequestHandler(server, 'tools/call');
    return handler(
        { method: 'tools/call', params: { name: tool.name, arguments: {}, _meta: { mcpSessionId: 's1' } } },
        { signal: { aborted: false }, sendNotification: vi.fn() },
    );
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/** Asserts the telemetry `properties` shape `trackToolCall` received for a failure class. */
function expectFailureClassTelemetry(
    trackSpy: { mock: { calls: [unknown, unknown, Record<string, unknown>][] } },
    fc: FailureClass,
): void {
    expect(trackSpy.mock.calls).toHaveLength(1);
    const properties = trackSpy.mock.calls[0][2];
    expect(Object.keys(properties).sort()).toEqual([...BASE_TELEMETRY_KEYS, ...fc.telemetryExtraKeys].sort());
    expect(properties.tool_status).toBe(fc.telemetry.tool_status);
    expect(properties.failure_category).toBe(fc.telemetry.failure_category);
    if (fc.telemetry.failure_http_status === undefined) {
        expect(properties).not.toHaveProperty('failure_http_status');
    } else {
        expect(properties.failure_http_status).toBe(fc.telemetry.failure_http_status);
    }
}

/** Drives a task-mode call, waits for terminal status, and reads back the stored task + result. */
async function runTaskAndReadBack(server: ActorsMcpServer, tool: ToolEntry) {
    server.upsertTools([tool]);
    const handler = getRequestHandler(server, 'tools/call');
    const res = (await handler(
        {
            method: 'tools/call',
            params: { name: tool.name, arguments: {}, _meta: { mcpSessionId: 's1' }, task: { ttl: 60_000 } },
        },
        { signal: { aborted: false }, sendNotification: vi.fn() },
    )) as { task: { taskId: string } };
    const task = await vi.waitFor(async () => {
        const current = await server.taskStore.getTask(res.task.taskId);
        if (!current || !TERMINAL_STATUSES.has(current.status)) {
            throw new Error(`Task ${res.task.taskId} did not reach a terminal status`);
        }
        return current;
    });
    const result = await server.taskStore.getTaskResult(res.task.taskId);
    return { task, result: result as Record<string, unknown> };
}

describe('CallToolRequestSchema handler', () => {
    afterEach(() => vi.restoreAllMocks());

    describe('sync failure result shapes', () => {
        it('returns the x402 payment-required response shape for a 402 failure', async () => {
            await withServer(async (server) => {
                silenceLogs();
                const result = await runSync(
                    server,
                    makeThrowingTool({ error: makePaymentRequiredError(X402_PAYMENT_DATA) }),
                );
                expect(result.isError).toBe(true);
                // Per the x402 MCP transport spec the payload rides both structuredContent and
                // content[0].text as JSON — payment clients parse these; pin both exactly.
                expect(result.content).toEqual(X402_RESPONSE_CONTENT);
                expect(result.structuredContent).toEqual(X402_PAYMENT_DATA);
                // Server-internal telemetry/status must not leak onto the wire.
                expect(result.toolTelemetry).toBeUndefined();
                expect('internalToolStatus' in result).toBe(false);
            });
        });

        it('returns the message-only payment-required response for a 402 without payment data', async () => {
            await withServer(async (server) => {
                silenceLogs();
                const result = await runSync(server, makeThrowingTool({ error: makePaymentRequiredError() }));
                expect(result.isError).toBe(true);
                expect(result.content).toEqual([{ type: 'text', text: 'Payment required' }]);
                expect(result.structuredContent).toBeUndefined();
                expect(result.toolTelemetry).toBeUndefined();
                expect('internalToolStatus' in result).toBe(false);
            });
        });

        it('returns the permission-approval response shape for a permission-approval failure', async () => {
            await withServer(async (server) => {
                silenceLogs();
                const result = await runSync(server, makeThrowingTool({ error: makePermissionApprovalError() }));
                expect(result.isError).toBe(true);
                expect(result.content).toEqual([{ type: 'text', text: 'needs approval' }]);
                expect(result.toolTelemetry).toBeUndefined();
                expect('internalToolStatus' in result).toBe(false);
            });
        });
    });

    it('rejects a task-augmented call to a tool without taskSupport before dispatch', async () => {
        await withServer(async (server) => {
            silenceLogs();
            const { tool, received } = makeRecorderTool('no-task-support-tool');
            server.upsertTools([tool]);
            // failInvalidParams awaits sendLoggingMessage before throwing McpError; the harness has
            // no transport (notification would throw "Not connected"), so stub it to observe the
            // real InvalidParams rejection.
            vi.spyOn(server.server, 'sendLoggingMessage').mockResolvedValue(undefined);
            const handler = getRequestHandler(server, 'tools/call');
            await expect(
                handler(
                    {
                        method: 'tools/call',
                        params: {
                            name: 'no-task-support-tool',
                            arguments: {},
                            _meta: { mcpSessionId: 's1' },
                            task: { ttl: 60_000 },
                        },
                    },
                    { signal: { aborted: false }, sendNotification: vi.fn() },
                ),
            ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
            expect(received.called).toBe(false);
        });
    });

    it('rejects arguments failing the input schema as an InvalidParams protocol error', async () => {
        // Pins the deliberate divergence from SDK 1.29 defaults: validation failures surface as
        // McpError protocol errors, never as isError tool results. The taskSupport-gate test above
        // covers the other failInvalidParams instance; this one covers AJV validation.
        await withServer(async (server) => {
            silenceLogs();
            const { tool, received } = makeRecorderTool('strict-schema-tool');
            const schema = { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] };
            tool.inputSchema = schema as ToolInputSchema;
            tool.ajvValidate = compileSchema(schema);
            server.upsertTools([tool]);
            vi.spyOn(server.server, 'sendLoggingMessage').mockResolvedValue(undefined);
            const handler = getRequestHandler(server, 'tools/call');
            await expect(
                handler(
                    {
                        method: 'tools/call',
                        params: { name: 'strict-schema-tool', arguments: {}, _meta: { mcpSessionId: 's1' } },
                    },
                    { signal: { aborted: false }, sendNotification: vi.fn() },
                ),
            ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
            expect(received.called).toBe(false);
        });
    });

    describe('tool-call telemetry properties per failure class', () => {
        // Telemetry on: no token + allowUnauthMode so prepareTelemetryData skips the userInfo network
        // call (userId null) while trackToolCall still fires. Assert the properties shape per class.
        for (const fc of FAILURE_CLASSES) {
            it(`emits telemetry properties for a ${fc.label} failure`, async () => {
                const trackSpy = vi.spyOn(telemetry, 'trackToolCall').mockImplementation(() => {});
                await withServer(
                    async (server) => {
                        silenceLogs();
                        await runSync(server, makeThrowingTool({ error: fc.makeError() }));
                    },
                    { token: undefined, telemetry: { enabled: true }, allowUnauthMode: true },
                );
                expectFailureClassTelemetry(trackSpy, fc);
            });
        }
    });
});

describe('executeToolAndUpdateTask()', () => {
    afterEach(() => vi.restoreAllMocks());

    describe('task terminal status per failure class', () => {
        for (const fc of FAILURE_CLASSES) {
            it(`stores a ${fc.label} failure with terminal status ${fc.taskStatus}`, async () => {
                await withServer(async (server) => {
                    silenceLogs();
                    const tool = makeThrowingTool({ error: fc.makeError(), taskSupport: 'optional' });
                    const { task, result } = await runTaskAndReadBack(server, tool);

                    expect(task.status).toBe(fc.taskStatus);
                    // Exact-object pin: a payment client fetches this via tasks/result, so the
                    // payload must not drift, and no internal key (toolTelemetry,
                    // internalToolStatus on completed classes) may appear.
                    expect(result).toEqual(fc.storedResult);
                });
            });
        }
    });

    describe('task-call telemetry properties per failure class', () => {
        // Same seam and per-class expectations as the sync block: the task catch assigns
        // callDiagnostics from the shared mapper's result via a flat overwrite, unlike the sync
        // path's spread-merge onto a pre-existing object, so pin it separately. Telemetry fires once
        // via finishTaskTracking; the emitted properties carry no task-specific key (taskId appears
        // only in the log line, not in the Segment properties).
        for (const fc of FAILURE_CLASSES) {
            it(`emits telemetry properties for a ${fc.label} failure in task mode`, async () => {
                const trackSpy = vi.spyOn(telemetry, 'trackToolCall').mockImplementation(() => {});
                await withServer(
                    async (server) => {
                        silenceLogs();
                        const tool = makeThrowingTool({ error: fc.makeError(), taskSupport: 'optional' });
                        await runTaskAndReadBack(server, tool);
                        // The task path stores the terminal result *before* finishTaskTracking fires
                        // trackToolCall, so terminal status alone does not imply telemetry was emitted.
                        await vi.waitFor(() => {
                            if (trackSpy.mock.calls.length === 0) throw new Error('trackToolCall spy was not called');
                        });
                        // Let any queued duplicate fire land before the single-call assertion below.
                        await new Promise((resolve) => {
                            setImmediate(resolve);
                        });
                        await new Promise((resolve) => {
                            setImmediate(resolve);
                        });
                    },
                    { token: undefined, telemetry: { enabled: true }, allowUnauthMode: true },
                );
                expectFailureClassTelemetry(trackSpy, fc);
                expect(trackSpy.mock.calls[0][2]).not.toHaveProperty('taskId');
                expect(trackSpy.mock.calls[0][2]).not.toHaveProperty('task_id');
            });
        }
    });

    it('stores an empty {} completed result for an ACTOR_MCP tool in task mode', async () => {
        // KNOWN GAP (#1063): executeToolAndUpdateTask has no ACTOR_MCP dispatch branch, so `result`
        // stays the initial {} and is stored as `completed`. This pins today's buggy behavior. FLIP
        // WHEN #1063 LANDS: the task path will then dispatch the ACTOR_MCP tool and store a real
        // result, so update this test to assert that result instead of {}.
        await withServer(async (server) => {
            silenceLogs();
            const { task, result } = await runTaskAndReadBack(server, makeActorMcpTool());
            expect(task.status).toBe('completed');
            expect(result).toEqual({});
        });
    });
});

describe('CallToolRequestSchema handler — task-augmented pre-flight failures', () => {
    afterEach(() => vi.restoreAllMocks());

    // x402 payload the payment provider returns; asserted intact in the stored structuredContent.
    const X402_PAYLOAD = { x402Version: 1, accepts: [{ scheme: 'exact', resource: 'test' }] };

    /** Skyfire-like provider whose getPaymentRequiredData populates the x402 structuredContent. */
    function makePaymentProvider(): PaymentProvider {
        return {
            id: 'skyfire',
            allowsUnauthenticated: true,
            decorateToolSchema: (tool) => tool,
            validatePayment: (args) => (args['skyfire-pay-id'] ? null : 'Missing skyfire-pay-id'),
            getPaymentRequiredData: () => X402_PAYLOAD,
            getPaymentHeaders: (args): Record<string, string> =>
                args['skyfire-pay-id'] ? { 'skyfire-pay-id': args['skyfire-pay-id'] as string } : {},
            removePaymentFields: (args) => {
                const { 'skyfire-pay-id': _removed, ...rest } = args;
                return rest;
            },
            redactForLogging: (args) => ({ ...(args as Record<string, unknown>), 'skyfire-pay-id': '[REDACTED]' }),
        };
    }

    /** Drives a task-augmented call and returns the CreateTaskResult (already terminal on pre-flight failure). */
    async function callTask(
        server: ActorsMcpServer,
        tool: ToolEntry,
        args: Record<string, unknown>,
    ): Promise<{ task: { taskId: string; status: string } }> {
        server.upsertTools([tool]);
        const handler = getRequestHandler(server, 'tools/call');
        return (await handler(
            {
                method: 'tools/call',
                params: { name: tool.name, arguments: args, _meta: { mcpSessionId: 's1' }, task: { ttl: 60_000 } },
            },
            { signal: { aborted: false }, sendNotification: vi.fn() },
        )) as { task: { taskId: string; status: string } };
    }

    /** notifications/tasks/status statuses emitted via server.notification, in order. */
    function statusNotificationStatuses(notifySpy: ReturnType<typeof vi.spyOn>): (string | undefined)[] {
        return (notifySpy.mock.calls as unknown[][])
            .map((c) => c[0] as { method?: string; params?: { status?: string } })
            .filter((n) => n.method === 'notifications/tasks/status')
            .map((n) => n.params?.status);
    }

    /** Flush the setImmediate-deferred status notification (emitted after the response). */
    async function flushDeferredNotification(): Promise<void> {
        await new Promise((resolve) => {
            setImmediate(resolve);
        });
    }

    it('resolves a payment pre-flight failure as a terminal completed task, one completed notification', async () => {
        await withServer(
            async (server) => {
                silenceLogs();
                const notifySpy = vi.spyOn(server.server, 'notification').mockResolvedValue(undefined);
                const { tool, received } = makeRecorderTool('payment-tool', {
                    paymentRequired: true,
                    taskSupport: 'optional',
                });
                const res = await callTask(server, tool, {});

                // CreateTaskResult is already terminal — no observable `working` phase.
                expect(res.task.status).toBe('completed');
                // The tool implementation never ran.
                expect(received.called).toBe(false);
                // Stored result carries the x402 payload intact.
                const stored = (await server.taskStore.getTaskResult(res.task.taskId)) as Record<string, unknown>;
                expect(stored.isError).toBe(true);
                expect(stored.structuredContent).toEqual(X402_PAYLOAD);
                // Exactly one status notification, `completed`, emitted after the response.
                expect(statusNotificationStatuses(notifySpy)).toEqual([]);
                await flushDeferredNotification();
                expect(statusNotificationStatuses(notifySpy)).toEqual(['completed']);
            },
            { paymentProvider: makePaymentProvider() },
        );
    });

    it('stores a payment pre-flight result deep-equal to the sync (non-task) path result', async () => {
        await withServer(
            async (server) => {
                silenceLogs();
                vi.spyOn(server.server, 'notification').mockResolvedValue(undefined);
                const handler = getRequestHandler(server, 'tools/call');

                // Non-task sync path returns the paymentRequiredResult directly.
                const syncTool = makeRecorderTool('payment-tool-sync', { paymentRequired: true }).tool;
                server.upsertTools([syncTool]);
                const syncResult = await handler(
                    {
                        method: 'tools/call',
                        params: { name: 'payment-tool-sync', arguments: {}, _meta: { mcpSessionId: 's1' } },
                    },
                    { signal: { aborted: false }, sendNotification: vi.fn() },
                );

                // Task path stores the same failure as a completed result.
                const taskTool = makeRecorderTool('payment-tool-task', {
                    paymentRequired: true,
                    taskSupport: 'optional',
                }).tool;
                const res = await callTask(server, taskTool, {});
                const stored = await server.taskStore.getTaskResult(res.task.taskId);

                expect(stored).toEqual(syncResult);
            },
            { paymentProvider: makePaymentProvider() },
        );
    });

    it('resolves a standby pre-flight rejection as a terminal completed task, one completed notification', async () => {
        await withServer(
            async (server) => {
                silenceLogs();
                const standbyResult = { content: [{ type: 'text', text: 'standby not supported' }], isError: true };
                const standbySpy = vi
                    .spyOn(callActor, 'checkPaymentProviderStandbyConflict')
                    .mockResolvedValue(standbyResult);
                const notifySpy = vi.spyOn(server.server, 'notification').mockResolvedValue(undefined);
                const { tool, received } = makeRecorderTool(HELPER_TOOLS.ACTOR_CALL, { taskSupport: 'optional' });
                const res = await callTask(server, tool, { actor: 'apify/some-actor' });

                expect(res.task.status).toBe('completed');
                expect(received.called).toBe(false);
                const stored = await server.taskStore.getTaskResult(res.task.taskId);
                expect(stored).toEqual(standbyResult);
                await flushDeferredNotification();
                expect(statusNotificationStatuses(notifySpy)).toEqual(['completed']);
                // No second, asynchronous re-evaluation of the already-known outcome (criterion 13).
                expect(standbySpy).toHaveBeenCalledTimes(1);
            },
            { paymentProvider: makePaymentProvider() },
        );
    });

    it('prefers the standby rejection over a payment-required failure when both apply', async () => {
        await withServer(
            async (server) => {
                silenceLogs();
                const standbyResult = { content: [{ type: 'text', text: 'standby not supported' }], isError: true };
                vi.spyOn(callActor, 'checkPaymentProviderStandbyConflict').mockResolvedValue(standbyResult);
                vi.spyOn(server.server, 'notification').mockResolvedValue(undefined);
                // paymentRequired + missing skyfire-pay-id would also yield paymentRequiredResult.
                const { tool } = makeRecorderTool(HELPER_TOOLS.ACTOR_CALL, {
                    paymentRequired: true,
                    taskSupport: 'optional',
                });
                const res = await callTask(server, tool, { actor: 'apify/some-actor' });

                const stored = (await server.taskStore.getTaskResult(res.task.taskId)) as Record<string, unknown>;
                // Standby result wins — not the x402 payment payload.
                expect(stored).toEqual(standbyResult);
                expect(stored.structuredContent).toBeUndefined();
            },
            { paymentProvider: makePaymentProvider() },
        );
    });

    it('records telemetry once with the sync-path pre-flight properties, no taskId', async () => {
        const trackSpy = vi.spyOn(telemetry, 'trackToolCall').mockImplementation(() => {});
        await withServer(
            async (server) => {
                silenceLogs();
                vi.spyOn(server.server, 'notification').mockResolvedValue(undefined);
                const { tool } = makeRecorderTool('payment-tool', { paymentRequired: true, taskSupport: 'optional' });
                await callTask(server, tool, {});
            },
            {
                token: undefined,
                telemetry: { enabled: true },
                allowUnauthMode: true,
                paymentProvider: makePaymentProvider(),
            },
        );
        // Same properties the sync 402 pre-flight path records (FAILURE_CLASSES[0]).
        expectFailureClassTelemetry(trackSpy, FAILURE_CLASSES[0]);
        expect(trackSpy.mock.calls[0][2]).not.toHaveProperty('taskId');
    });

    it('records standby telemetry with INVALID_INPUT and no failure_http_status', async () => {
        const trackSpy = vi.spyOn(telemetry, 'trackToolCall').mockImplementation(() => {});
        await withServer(
            async (server) => {
                silenceLogs();
                const standbyResult = { content: [{ type: 'text', text: 'standby not supported' }], isError: true };
                vi.spyOn(callActor, 'checkPaymentProviderStandbyConflict').mockResolvedValue(standbyResult);
                vi.spyOn(server.server, 'notification').mockResolvedValue(undefined);
                const { tool } = makeRecorderTool(HELPER_TOOLS.ACTOR_CALL, { taskSupport: 'optional' });
                await callTask(server, tool, { actor: 'apify/some-actor' });
            },
            {
                token: undefined,
                telemetry: { enabled: true },
                allowUnauthMode: true,
                paymentProvider: makePaymentProvider(),
            },
        );
        expect(trackSpy.mock.calls).toHaveLength(1);
        const properties = trackSpy.mock.calls[0][2] as Record<string, unknown>;
        expect(properties.tool_status).toBe(TOOL_STATUS.SOFT_FAIL);
        expect(properties.failure_category).toBe(FAILURE_CATEGORY.INVALID_INPUT);
        // Standby is not a 402 — the sync short-circuit omits failure_http_status and so must this path.
        expect(properties).not.toHaveProperty('failure_http_status');
        expect(properties).not.toHaveProperty('taskId');
    });

    it('stores a standby pre-flight result deep-equal to the sync (non-task) path result', async () => {
        await withServer(
            async (server) => {
                silenceLogs();
                const standbyResult = { content: [{ type: 'text', text: 'standby not supported' }], isError: true };
                vi.spyOn(callActor, 'checkPaymentProviderStandbyConflict').mockResolvedValue(standbyResult);
                vi.spyOn(server.server, 'notification').mockResolvedValue(undefined);
                const { tool } = makeRecorderTool(HELPER_TOOLS.ACTOR_CALL, { taskSupport: 'optional' });
                server.upsertTools([tool]);
                const handler = getRequestHandler(server, 'tools/call');

                // Non-task sync path returns the standbyRejection directly.
                const syncResult = await handler(
                    {
                        method: 'tools/call',
                        params: {
                            name: tool.name,
                            arguments: { actor: 'apify/some-actor' },
                            _meta: { mcpSessionId: 's1' },
                        },
                    },
                    { signal: { aborted: false }, sendNotification: vi.fn() },
                );

                // Task path stores the same failure as a completed result.
                const res = await callTask(server, tool, { actor: 'apify/some-actor' });
                const stored = await server.taskStore.getTaskResult(res.task.taskId);

                expect(stored).toEqual(syncResult);
            },
            { paymentProvider: makePaymentProvider() },
        );
    });

    it('surfaces a non-expiry store failure as an InternalError protocol error', async () => {
        // A store outage (anything but the tolerated task-not-found) must reject as a protocol
        // error — a task-less tool result would fail the client's CreateTaskResult parse opaquely.
        await withServer(
            async (server) => {
                silenceLogs();
                vi.spyOn(server.server, 'notification').mockResolvedValue(undefined);
                vi.spyOn(server.taskStore, 'storeTaskResult').mockRejectedValue(new Error('store unavailable'));
                const { tool } = makeRecorderTool('payment-tool', { paymentRequired: true, taskSupport: 'optional' });
                server.upsertTools([tool]);
                const handler = getRequestHandler(server, 'tools/call');
                await expect(
                    handler(
                        {
                            method: 'tools/call',
                            params: {
                                name: 'payment-tool',
                                arguments: {},
                                _meta: { mcpSessionId: 's1' },
                                task: { ttl: 60_000 },
                            },
                        },
                        { signal: { aborted: false }, sendNotification: vi.fn() },
                    ),
                ).rejects.toMatchObject({ code: ErrorCode.InternalError });
            },
            { paymentProvider: makePaymentProvider() },
        );
    });

    it('logs Tool call completed with the taskId for a pre-flight task failure', async () => {
        // The pre-flight path's telemetry rides the handler finally; the log line must keep the
        // taskId the async path logs via finishTaskTracking, so hosted log queries keep
        // classifying this class as task-mode.
        await withServer(
            async (server) => {
                const infoSpy = vi.spyOn(log, 'info').mockImplementation(() => log);
                silenceLogs();
                vi.spyOn(server.server, 'notification').mockResolvedValue(undefined);
                const { tool } = makeRecorderTool('payment-tool', { paymentRequired: true, taskSupport: 'optional' });
                const res = await callTask(server, tool, {});
                const completedCall = infoSpy.mock.calls.find(([message]) => message === 'Tool call completed');
                expect(completedCall?.[1]).toMatchObject({ taskId: res.task.taskId });
            },
            { paymentProvider: makePaymentProvider() },
        );
    });

    it('returns a completed task even when the task expires before the result store', async () => {
        // The one case storeTaskResultOrSkipIfExpired tolerates: TTL elapsed between createTask and
        // the result store. The store throws not-found (swallowed) and the task is gone — the wire
        // CreateTaskResult must still report `completed`, never the pre-write `working` snapshot.
        await withServer(
            async (server) => {
                silenceLogs();
                const notifySpy = vi.spyOn(server.server, 'notification').mockResolvedValue(undefined);
                vi.spyOn(server.taskStore, 'storeTaskResult').mockRejectedValue(
                    new Error('Task with ID some-task not found'),
                );
                vi.spyOn(server.taskStore, 'getTask').mockResolvedValue(null);
                const { tool, received } = makeRecorderTool('payment-tool', {
                    paymentRequired: true,
                    taskSupport: 'optional',
                });
                const res = await callTask(server, tool, {});

                expect(res.task.status).toBe('completed');
                expect(received.called).toBe(false);
                // Task is gone from the store — no status notification can be emitted.
                await flushDeferredNotification();
                expect(statusNotificationStatuses(notifySpy)).toEqual([]);
            },
            { paymentProvider: makePaymentProvider() },
        );
    });
});
