import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import log from '@apify/log';

import { APIFY_ERROR_TYPE_FULL_PERMISSION_NOT_APPROVED, FAILURE_CATEGORY, TOOL_STATUS } from '../../src/const.js';
import type { ActorsMcpServer } from '../../src/mcp/server.js';
import * as telemetry from '../../src/telemetry.js';
import type { ToolEntry, ToolInputSchema } from '../../src/types.js';
import { TOOL_TYPE } from '../../src/types.js';
import { compileSchema } from '../../src/utils/ajv.js';
import { getRequestHandler, makeRecorderTool, makeThrowingTool, withServer } from './helpers/mcp_server.js';

/**
 * Pins the handler-level behavior contracts that umbrella #658 will merge (the sync
 * `CallToolRequestSchema` catch and the `executeToolAndUpdateTask` catch). Failure classes are
 * fabricated by throwing from a fake tool's `call`; both the sync path (result shapes) and the task
 * path (terminal status mapping) assert the same source-of-truth per class.
 */

const PERMISSION_HTTP_STATUS = 403;

/** A 402 x402 payment-required condition. Any object with `statusCode: 402` satisfies the predicate. */
function makePaymentRequiredError(): Error {
    return Object.assign(new Error('Payment required'), { statusCode: 402 });
}

/** A real full-permission-not-approved `ApifyApiError`, built against the src/const.ts type constant. */
function makePermissionApprovalError(): ApifyApiError {
    return new ApifyApiError(
        {
            data: { error: { type: APIFY_ERROR_TYPE_FULL_PERMISSION_NOT_APPROVED, message: 'needs approval' } },
            status: PERMISSION_HTTP_STATUS,
        } as AxiosResponse,
        1,
    );
}

type FailureClass = {
    label: string;
    makeError: () => unknown;
    taskStatus: 'completed' | 'failed';
    /** Set only for the generic class — 402/approval store no internalToolStatus. */
    internalToolStatus?: string;
    telemetry: { tool_status: string; failure_category: string; failure_http_status?: number };
};

const FAILURE_CLASSES: FailureClass[] = [
    {
        label: '402 payment-required',
        makeError: makePaymentRequiredError,
        taskStatus: 'completed',
        telemetry: {
            tool_status: TOOL_STATUS.SOFT_FAIL,
            failure_category: FAILURE_CATEGORY.INVALID_INPUT,
            failure_http_status: 402,
        },
    },
    {
        label: 'permission-approval',
        makeError: makePermissionApprovalError,
        taskStatus: 'completed',
        telemetry: {
            tool_status: TOOL_STATUS.SOFT_FAIL,
            failure_category: FAILURE_CATEGORY.PERMISSION_APPROVAL_REQUIRED,
            failure_http_status: PERMISSION_HTTP_STATUS,
        },
    },
    {
        label: 'generic execution error',
        makeError: () => new Error('boom'),
        taskStatus: 'failed',
        internalToolStatus: TOOL_STATUS.FAILED,
        telemetry: {
            tool_status: TOOL_STATUS.FAILED,
            failure_category: FAILURE_CATEGORY.INTERNAL_ERROR,
        },
    },
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
        it('returns the payment-required response shape for a 402 failure', async () => {
            await withServer(async (server) => {
                silenceLogs();
                const result = await runSync(server, makeThrowingTool({ error: makePaymentRequiredError() }));
                expect(result.isError).toBe(true);
                expect(result.content).toEqual([{ type: 'text', text: 'Payment required' }]);
                // Server-internal telemetry/status must not leak onto the wire.
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
                    if (fc.internalToolStatus === undefined) {
                        expect('internalToolStatus' in result).toBe(false);
                    } else {
                        expect(result.isError).toBe(true);
                        expect(result.internalToolStatus).toBe(fc.internalToolStatus);
                    }
                });
            });
        }
    });

    describe('task-call telemetry properties per failure class', () => {
        // Same seam and per-class expectations as the sync block: the task catch builds its
        // callDiagnostics via its own duplicated inline logic (the duplication #658 merges), so pin
        // it separately. Telemetry fires once via finishTaskTracking; the emitted properties carry
        // no task-specific key (taskId appears only in the log line, not in the Segment properties).
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
                    },
                    { token: undefined, telemetry: { enabled: true }, allowUnauthMode: true },
                );
                expectFailureClassTelemetry(trackSpy, fc);
                expect(trackSpy.mock.calls[0][2]).not.toHaveProperty('taskId');
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
