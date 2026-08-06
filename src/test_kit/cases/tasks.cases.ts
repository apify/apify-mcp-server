import type { Client as ClientV1 } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { expect } from 'vitest';

import { ApifyClient } from '../../apify_client.js';
import { HELPER_TOOLS } from '../../const.js';
import { actorNameToToolName } from '../../tools/actor_tool_naming.js';
import {
    ACTOR_NORMAL_MODE,
    assertStatusMessagePropagated,
    captureRunIdFromProgress,
    waitForRunAborted,
} from '../helpers.js';
import type { Case, CaseCtx } from '../types.js';

// Tasks cases need the v1 SDK's `.experimental.tasks`/`.request()` API, which the 2026-07-28
// v2 client and stdio both lack (v2 has no tasks capability; stdio isn't a dimension internal
// runs at all) — restrict to 2025-11-25 (streamable HTTP) only, same gate every case here uses.
function onlyLegacyHttp(ctx: CaseCtx): boolean {
    return ctx.transport !== '2025-11-25';
}

/**
 * Async task protocol: long-running `tasks/call`, `tasks/get`/`tasks/list`, cancellation via
 * `notifications/cancelled` and `tasks/cancel`, and statusMessage propagation. All marked
 * `critical: true` — internal gains real async-task/notification coverage against its own live
 * deploy by importing this array, instead of hand-duplicating it.
 */
export const tasksCases: Case[] = [
    {
        name: 'should abort actor run on notifications/cancelled',
        critical: true,
        skipIf: onlyLegacyHttp,
        retry: 2,
        run: async (ctx) => {
            const selectedToolName = actorNameToToolName(ACTOR_NORMAL_MODE);
            // Load the Actor at connection time — add-actor's dynamic add is gone (PR 0).
            const client = (await ctx.createClientFn({ actors: [ACTOR_NORMAL_MODE] })) as ClientV1;
            try {
                const api = new ApifyClient({ token: ctx.getApifyToken(), baseUrl: ctx.getApifyApiBaseUrl() });
                const controller = new AbortController();
                const { onprogress, runIdPromise } = captureRunIdFromProgress();
                const requestPromise = client
                    .request(
                        {
                            method: 'tools/call' as const,
                            params: {
                                name: selectedToolName,
                                arguments: { firstNumber: 1, secondNumber: 2, waitSeconds: 60 },
                            },
                        },
                        CallToolResultSchema,
                        { signal: controller.signal, onprogress },
                    )
                    // Swallow "AbortError: This operation was aborted" — expected after cancel.
                    .catch(() => undefined);

                const runId = await runIdPromise;
                expect(runId).toBeTruthy();
                controller.abort();
                await requestPromise;

                await waitForRunAborted(api, runId);
            } finally {
                await client.close();
            }
        },
    },
    {
        name: 'should abort call-actor tool on notifications/cancelled',
        critical: true,
        skipIf: onlyLegacyHttp,
        retry: 1,
        run: async (ctx) => {
            const client = (await ctx.createClientFn({ tools: ['actors'] })) as ClientV1;
            try {
                const api = new ApifyClient({ token: ctx.getApifyToken(), baseUrl: ctx.getApifyApiBaseUrl() });
                const controller = new AbortController();
                const { onprogress, runIdPromise } = captureRunIdFromProgress();
                const requestPromise = client
                    .request(
                        {
                            method: 'tools/call' as const,
                            params: {
                                name: HELPER_TOOLS.ACTOR_CALL,
                                arguments: {
                                    actor: ACTOR_NORMAL_MODE,
                                    step: 'call',
                                    input: { firstNumber: 1, secondNumber: 2, waitSeconds: 60 },
                                },
                            },
                        },
                        CallToolResultSchema,
                        { signal: controller.signal, onprogress },
                    )
                    .catch(() => undefined);

                const runId = await runIdPromise;
                expect(runId).toBeTruthy();
                controller.abort();
                await requestPromise;

                await waitForRunAborted(api, runId);
            } finally {
                await client.close();
            }
        },
    },
    {
        name: 'should be able to call a long running task tool call',
        critical: true,
        skipIf: onlyLegacyHttp,
        run: async (ctx) => {
            const client = (await ctx.createClientFn({ tools: [ACTOR_NORMAL_MODE] })) as ClientV1;
            try {
                const stream = client.experimental.tasks.callToolStream(
                    {
                        name: actorNameToToolName(ACTOR_NORMAL_MODE),
                        // waitSeconds keeps the run open long enough to emit taskStatus updates.
                        arguments: { firstNumber: 1, secondNumber: 2, waitSeconds: 10 },
                    },
                    CallToolResultSchema,
                    { task: { ttl: 60000 } }, // Keep results for 60 seconds
                );

                let lastStatus = '';
                let taskStatusCount = 0;
                let resultReceived = false;
                for await (const message of stream) {
                    switch (message.type) {
                        case 'taskCreated':
                            break;
                        case 'taskStatus':
                            taskStatusCount++;
                            lastStatus = message.task.status;
                            break;
                        case 'result':
                            message.result.content.forEach((item) => {
                                expect(item).toHaveProperty('type');
                            });
                            resultReceived = true;
                            break;
                        case 'error':
                            throw message.error;
                        default:
                            throw new Error(`Unknown message type: ${(message as unknown as { type: string }).type}`);
                    }
                }
                expect(resultReceived).toBe(true);
                // Regression guard: notifications/tasks/status must reach the client over the
                // session-level transport (standalone SSE on streamable HTTP). If notifications
                // are dropped, callToolStream emits no taskStatus events.
                expect(taskStatusCount).toBeGreaterThan(0);
                expect(lastStatus).not.toBe('');
            } finally {
                await client.close();
            }
        },
    },
    {
        name: 'should be able to call a long running task and list it, get the status and then separately retrieve the result',
        critical: true,
        skipIf: onlyLegacyHttp,
        run: async (ctx) => {
            const client = (await ctx.createClientFn({ tools: [ACTOR_NORMAL_MODE] })) as ClientV1;
            try {
                const stream = client.experimental.tasks.callToolStream(
                    {
                        name: actorNameToToolName(ACTOR_NORMAL_MODE),
                        // waitSeconds keeps the run open long enough to observe `working` status.
                        arguments: { firstNumber: 3, secondNumber: 4, waitSeconds: 10 },
                    },
                    CallToolResultSchema,
                    { task: { ttl: 60000 } },
                );

                let taskId: string | null = null;
                for await (const message of stream) {
                    if (message.type === 'taskCreated') {
                        taskId = message.task.taskId;

                        const taskStatus = await client.experimental.tasks.getTask(taskId);
                        expect(taskStatus).toHaveProperty('status');
                        expect(taskStatus.status).toBe('working');

                        const tasks = await client.experimental.tasks.listTasks();
                        const taskIds = tasks.tasks.map((task) => task.taskId);
                        expect(taskIds).toContain(taskId);
                    } else if (message.type === 'result') {
                        if (!taskId) throw new Error('Task ID should be set before receiving result');
                        const result = await client.experimental.tasks.getTaskResult(taskId, CallToolResultSchema);
                        const content = result.content as { text: string; type: string }[];
                        expect(content.length).toBe(2);
                    }
                }
            } finally {
                await client.close();
            }
        },
    },
    {
        name: 'should be able to call a long running task and then cancel it midway',
        critical: true,
        skipIf: onlyLegacyHttp,
        run: async (ctx) => {
            const client = (await ctx.createClientFn({ tools: [ACTOR_NORMAL_MODE] })) as ClientV1;
            try {
                const stream = client.experimental.tasks.callToolStream(
                    {
                        name: actorNameToToolName(ACTOR_NORMAL_MODE),
                        // waitSeconds keeps the run open long enough to cancel it mid-flight.
                        arguments: { firstNumber: 5, secondNumber: 6, waitSeconds: 60 },
                    },
                    CallToolResultSchema,
                    { task: { ttl: 60000 } },
                );

                for await (const message of stream) {
                    if (message.type === 'taskCreated') {
                        await client.experimental.tasks.cancelTask(message.task.taskId);
                    } else if (message.type === 'taskStatus') {
                        expect(message.task.status).toBe('cancelled');
                    } else if (message.type === 'result') {
                        throw new Error('Task should have been cancelled before completion');
                    }
                }
            } finally {
                await client.close();
            }
        },
    },
    {
        name: 'should abort the Apify run when tasks/cancel is sent (direct actor tool)',
        critical: true,
        skipIf: onlyLegacyHttp,
        retry: 3,
        // Without the chained AbortController, the task flips to `cancelled` but the underlying
        // Apify run keeps consuming compute until natural finish.
        run: async (ctx) => {
            const client = (await ctx.createClientFn({ tools: [ACTOR_NORMAL_MODE] })) as ClientV1;
            try {
                const api = new ApifyClient({ token: ctx.getApifyToken(), baseUrl: ctx.getApifyApiBaseUrl() });
                const { onprogress, runIdPromise } = captureRunIdFromProgress();

                const stream = client.experimental.tasks.callToolStream(
                    {
                        name: actorNameToToolName(ACTOR_NORMAL_MODE),
                        // waitSeconds keeps the run open long enough to capture, cancel, and verify abort.
                        arguments: { firstNumber: 1, secondNumber: 2, waitSeconds: 60 },
                    },
                    CallToolResultSchema,
                    { task: { ttl: 60000 }, onprogress },
                );

                let cancelled = false;
                for await (const message of stream) {
                    if (message.type === 'taskCreated') {
                        // Cancel once the run is confirmed started (runId observed), not before.
                        await runIdPromise;
                        await client.experimental.tasks.cancelTask(message.task.taskId);
                        cancelled = true;
                    } else if (message.type === 'result') {
                        throw new Error('Task should have been cancelled before completion');
                    }
                }
                expect(cancelled).toBe(true);

                const runId = await runIdPromise;
                await waitForRunAborted(api, runId);
            } finally {
                await client.close();
            }
        },
    },
    {
        name: 'should support call-actor tool in task mode (internal tool with taskSupport)',
        critical: true,
        skipIf: onlyLegacyHttp,
        run: async (ctx) => {
            const client = (await ctx.createClientFn({ tools: ['actors'] })) as ClientV1;
            try {
                const stream = client.experimental.tasks.callToolStream(
                    {
                        name: HELPER_TOOLS.ACTOR_CALL,
                        arguments: { actor: ACTOR_NORMAL_MODE, input: { firstNumber: 10, secondNumber: 20 } },
                    },
                    CallToolResultSchema,
                    { task: { ttl: 60000 } },
                );

                let resultReceived = false;
                let taskCreated = false;
                for await (const message of stream) {
                    switch (message.type) {
                        case 'taskCreated':
                            taskCreated = true;
                            expect(message.task.taskId).toBeDefined();
                            break;
                        case 'taskStatus':
                            expect(['working', 'completed']).toContain(message.task.status);
                            break;
                        case 'result': {
                            const content = message.result.content as { text: string; type: string }[];
                            expect(content.length).toBeGreaterThan(0);
                            const resultText = content.map((c) => c.text).join(' ');
                            expect(resultText.length).toBeGreaterThan(0);
                            resultReceived = true;
                            break;
                        }
                        case 'error':
                            throw message.error;
                        default:
                            throw new Error(`Unknown message type: ${(message as unknown as { type: string }).type}`);
                    }
                }

                expect(taskCreated).toBe(true);
                expect(resultReceived).toBe(true);
            } finally {
                await client.close();
            }
        },
    },
    {
        name: 'should propagate statusMessage to tasks/get and tasks/list for internal tools in task mode',
        critical: true,
        skipIf: onlyLegacyHttp,
        retry: 1,
        // WARNING: can be flaky on streamable HTTP transport due to timing — the Actor may
        // complete before the progress polling interval (PROGRESS_NOTIFICATION_INTERVAL_MS)
        // fires a statusMessage. See: https://github.com/apify/apify-mcp-server/issues/558
        run: async (ctx) => {
            const client = (await ctx.createClientFn({ tools: ['actors'] })) as ClientV1;
            try {
                const stream = client.experimental.tasks.callToolStream(
                    {
                        name: HELPER_TOOLS.ACTOR_CALL,
                        // waitSeconds keeps the run open long enough for the polling interval to
                        // emit at least one statusMessage notification.
                        arguments: {
                            actor: ACTOR_NORMAL_MODE,
                            input: { firstNumber: 1, secondNumber: 2, waitSeconds: 10 },
                        },
                    },
                    CallToolResultSchema,
                    { task: { ttl: 60000 } },
                );

                await assertStatusMessagePropagated(client, stream);
            } finally {
                await client.close();
            }
        },
    },
    {
        name: 'should propagate statusMessage to tasks/get and tasks/list for actor tools in task mode',
        critical: true,
        skipIf: onlyLegacyHttp,
        retry: 1,
        run: async (ctx) => {
            const client = (await ctx.createClientFn({ tools: [ACTOR_NORMAL_MODE] })) as ClientV1;
            try {
                const stream = client.experimental.tasks.callToolStream(
                    {
                        name: actorNameToToolName(ACTOR_NORMAL_MODE),
                        // waitSeconds keeps the run open long enough for the polling interval to
                        // emit at least one statusMessage notification.
                        arguments: { firstNumber: 1, secondNumber: 2, waitSeconds: 10 },
                    },
                    CallToolResultSchema,
                    { task: { ttl: 60000 } },
                );

                await assertStatusMessagePropagated(client, stream);
            } finally {
                await client.close();
            }
        },
    },
];
