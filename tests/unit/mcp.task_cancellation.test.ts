import { afterEach, describe, expect, it, vi } from 'vitest';

import log from '@apify/log';

import { FAILURE_CATEGORY, TOOL_STATUS } from '../../src/const.js';
import * as telemetry from '../../src/telemetry.js';
import type { ToolCallTelemetryProperties } from '../../src/types.js';
import {
    getRequestHandler,
    getTaskStore,
    makeBlockingTool,
    makePaymentRequiredError,
    makePermissionApprovalError,
    withServer,
    X402_PAYMENT_DATA,
} from './helpers/mcp_server.js';

/**
 * Pins the cancel-during-execution guard (`skipIfTaskCancelled`, `src/mcp/task_execution.ts`). The
 * MCP tasks spec requires a cancelled task to stay cancelled, so no storage path may write a result
 * once `tasks/cancel` has landed.
 */

const SESSION_ID = 's1';

function silenceLogs(): void {
    vi.spyOn(log, 'error').mockImplementation(() => log);
    vi.spyOn(log, 'exception').mockImplementation(() => log);
    vi.spyOn(log, 'softFail').mockImplementation(() => log);
    vi.spyOn(log, 'warning').mockImplementation(() => log);
}

async function startTask(server: unknown, toolName: string): Promise<string> {
    const handler = getRequestHandler(server, 'tools/call');
    const response = (await handler(
        {
            method: 'tools/call',
            params: {
                name: toolName,
                arguments: {},
                _meta: { mcpSessionId: SESSION_ID },
                task: { ttl: 60_000 },
            },
        },
        { signal: { aborted: false }, sendNotification: vi.fn() },
    )) as { task: { taskId: string } };
    return response.task.taskId;
}

async function cancelTask(server: unknown, taskId: string): Promise<void> {
    const handler = getRequestHandler(server, 'tasks/cancel');
    await handler(
        { method: 'tasks/cancel', params: { taskId, _meta: { mcpSessionId: SESSION_ID } } },
        { signal: { aborted: false }, sendNotification: vi.fn() },
    );
}

describe('executeToolAndUpdateTask()', () => {
    afterEach(() => vi.restoreAllMocks());

    /**
     * A guarded run settles at `trackToolCall`, since the guard returns without touching the store or
     * the task status. An unguarded one may never get there: the store rejects a write onto a
     * cancelled task, and on the error paths that rejection escapes before `finishTaskTracking` runs.
     * Hence the wait on either spy, so a missing guard fails on the store assertion instead of
     * timing out.
     */
    async function runCancelledTask(outcome?: { error: unknown }): Promise<ToolCallTelemetryProperties> {
        const trackSpy = vi.spyOn(telemetry, 'trackToolCall').mockImplementation(() => {});
        await withServer(
            async (server) => {
                silenceLogs();
                const { tool, started, release } = makeBlockingTool();
                server.upsertTools([tool]);
                const storeSpy = vi.spyOn(getTaskStore(server), 'storeTaskResult');

                const taskId = await startTask(server, tool.name);
                await started;
                await cancelTask(server, taskId);
                release(outcome);

                await vi.waitFor(() => {
                    if (trackSpy.mock.calls.length === 0 && storeSpy.mock.calls.length === 0) {
                        throw new Error('task execution did not settle');
                    }
                });

                expect(storeSpy).not.toHaveBeenCalled();
                const task = await getTaskStore(server).getTask(taskId, SESSION_ID);
                expect(task?.status).toBe('cancelled');
                // Read path too, not just the spy: the store refuses to hand out a result that was
                // never written.
                await expect(getTaskStore(server).getTaskResult(taskId, SESSION_ID)).rejects.toThrow(
                    /has no result stored/,
                );
            },
            // Telemetry on with no token, as the task-telemetry tests do.
            { token: undefined, telemetry: { enabled: true }, allowUnauthMode: true },
        );
        expect(trackSpy.mock.calls).toHaveLength(1);
        return trackSpy.mock.calls[0][2];
    }

    it('stores no result when the tool succeeds after the task was cancelled', async () => {
        const properties = await runCancelledTask();

        expect(properties.tool_status).toBe(TOOL_STATUS.ABORTED);
    });

    it('stores no result when a 402 lands after the task was cancelled', async () => {
        const properties = await runCancelledTask({ error: makePaymentRequiredError(X402_PAYMENT_DATA) });

        expect(properties.tool_status).toBe(TOOL_STATUS.ABORTED);
    });

    it('stores no result when a permission-approval error lands after the task was cancelled', async () => {
        const properties = await runCancelledTask({ error: makePermissionApprovalError() });

        expect(properties.tool_status).toBe(TOOL_STATUS.ABORTED);
    });

    it('stores no result when the tool throws after the task was cancelled', async () => {
        const properties = await runCancelledTask({ error: new Error('boom') });

        // The failure category still pins the execution-error arm.
        expect(properties.failure_category).toBe(FAILURE_CATEGORY.INTERNAL_ERROR);
        expect(properties.tool_status).toBe(TOOL_STATUS.ABORTED);
    });
});
