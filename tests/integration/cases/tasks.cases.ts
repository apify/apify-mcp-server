import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { expect, it } from 'vitest';

import { ApifyClient } from '../../../src/apify_client.js';
import { HELPER_TOOLS } from '../../../src/const.js';
import { actorNameToToolName } from '../../../src/tools/actor_tool_naming.js';
import { ACTOR_NORMAL_MODE } from '../../const.js';
import { asLegacyClient, type McpSuiteClient } from '../../helpers.js';
import { assertStatusMessagePropagated, captureRunIdFromProgress, waitForRunAborted } from '../utils/task_waits.js';
import type { CasesCtx } from './shared.js';

/**
 * Async task protocol: long-running `tasks/call`, `tasks/get`/`tasks/list`, cancellation via
 * `notifications/cancelled`, and statusMessage propagation.
 */
export function registerTasksCases(ctx: CasesCtx): void {
    const { createClientFn, hasTasksSupport, transport } = ctx;

    // Cancels an in-flight tools/call via notifications/cancelled, verifies the run aborted.
    it.runIf(transport === 'streamable-http')(
        'should abort actor run on notifications/cancelled',
        { retry: 2 },
        async () => {
            let client: McpSuiteClient | undefined;
            try {
                const selectedToolName = actorNameToToolName(ACTOR_NORMAL_MODE);
                // Load the Actor at connection time — add-actor's dynamic add is gone (PR 0).
                client = await createClientFn({ actors: [ACTOR_NORMAL_MODE] });

                const api = new ApifyClient({ token: process.env.APIFY_TOKEN as string });
                const controller = new AbortController();
                const { onprogress, runIdPromise } = captureRunIdFromProgress();
                const requestPromise = asLegacyClient(client)
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
                await client?.close();
            }
        },
    );

    it.runIf(transport === 'streamable-http')(
        'should abort call-actor tool on notifications/cancelled',
        { retry: 1 },
        async () => {
            let client: McpSuiteClient | undefined;
            try {
                client = await createClientFn({ tools: ['actors'] });

                const api = new ApifyClient({ token: process.env.APIFY_TOKEN as string });
                const controller = new AbortController();
                const { onprogress, runIdPromise } = captureRunIdFromProgress();
                const requestPromise = asLegacyClient(client)
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
                await client?.close();
            }
        },
    );

    // TODO: if we add more streamable task tool call tests it might be worth it to abstract the common logic but now it's not worth it
    it.runIf(hasTasksSupport)('should be able to call a long running task tool call', async () => {
        let client: McpSuiteClient | undefined;
        try {
            client = await createClientFn({ tools: [ACTOR_NORMAL_MODE] });
            const taskClient = asLegacyClient(client);

            const stream = taskClient.experimental.tasks.callToolStream(
                {
                    name: actorNameToToolName(ACTOR_NORMAL_MODE),
                    // waitSeconds keeps the run open long enough to emit taskStatus updates.
                    arguments: {
                        firstNumber: 1,
                        secondNumber: 2,
                        waitSeconds: 10,
                    },
                },
                CallToolResultSchema,
                {
                    task: {
                        ttl: 60000, // Keep results for 60 seconds
                    },
                },
            );

            let lastStatus = '';
            let taskStatusCount = 0;
            let resultReceived = false;
            for await (const message of stream) {
                switch (message.type) {
                    case 'taskCreated':
                        // Task created successfully with ID: message.task.taskId
                        break;
                    case 'taskStatus':
                        taskStatusCount++;
                        lastStatus = message.task.status;
                        break;
                    case 'result':
                        // Task completed successfully
                        message.result.content.forEach((item) => {
                            expect(item).toHaveProperty('type');
                        });
                        // Mark that we received the result
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
            await client?.close();
        }
    });

    it.runIf(hasTasksSupport)(
        'should be able to call a long running task and list it, get the status and then separately retrieve the result',
        async () => {
            let client: McpSuiteClient | undefined;
            try {
                client = await createClientFn({ tools: [ACTOR_NORMAL_MODE] });
                const taskClient = asLegacyClient(client);

                const stream = taskClient.experimental.tasks.callToolStream(
                    {
                        name: actorNameToToolName(ACTOR_NORMAL_MODE),
                        // waitSeconds keeps the run open long enough to observe `working` status.
                        arguments: {
                            firstNumber: 3,
                            secondNumber: 4,
                            waitSeconds: 10,
                        },
                    },
                    CallToolResultSchema,
                    {
                        task: {
                            ttl: 60000, // Keep results for 60 seconds
                        },
                    },
                );

                let taskId: string | null = null;
                for await (const message of stream) {
                    if (message.type === 'taskCreated') {
                        taskId = message.task.taskId;

                        // Now we can get the task status
                        const taskStatus = await taskClient.experimental.tasks.getTask(taskId);
                        expect(taskStatus).toHaveProperty('status');
                        expect(taskStatus.status).toBe('working');

                        // List and verify the task is present
                        const tasks = await taskClient.experimental.tasks.listTasks();
                        const taskIds = tasks.tasks.map((task) => task.taskId);
                        expect(taskIds).toContain(taskId);
                    } else if (message.type === 'result') {
                        // So typescript is happy
                        if (!taskId) throw new Error('Task ID should be set before receiving result');
                        // Task completed retrieve the result separately
                        const result = await taskClient.experimental.tasks.getTaskResult(taskId, CallToolResultSchema);
                        const content = result.content as { text: string; type: string }[];
                        expect(content.length).toBe(2);
                    }
                }
            } finally {
                await client?.close();
            }
        },
    );

    it.runIf(hasTasksSupport)('should be able to call a long running task and then cancel it midway', async () => {
        let client: McpSuiteClient | undefined;
        try {
            client = await createClientFn({ tools: [ACTOR_NORMAL_MODE] });
            const taskClient = asLegacyClient(client);

            const stream = taskClient.experimental.tasks.callToolStream(
                {
                    name: actorNameToToolName(ACTOR_NORMAL_MODE),
                    // waitSeconds keeps the run open long enough to cancel it mid-flight.
                    arguments: {
                        firstNumber: 5,
                        secondNumber: 6,
                        waitSeconds: 60,
                    },
                },
                CallToolResultSchema,
                {
                    task: {
                        ttl: 60000, // Keep results for 60 seconds
                    },
                },
            );

            let taskId: string | null = null;
            for await (const message of stream) {
                if (message.type === 'taskCreated') {
                    taskId = message.task.taskId;

                    await taskClient.experimental.tasks.cancelTask(taskId);
                } else if (message.type === 'taskStatus') {
                    expect(message.task.status).toBe('cancelled');
                } else if (message.type === 'result') {
                    throw new Error('Task should have been cancelled before completion');
                }
            }
        } finally {
            await client?.close();
        }
    });

    // Without the chained AbortController, the task flips to `cancelled` but the underlying
    // Apify run keeps consuming compute until natural finish.
    it.runIf(hasTasksSupport)(
        'should abort the Apify run when tasks/cancel is sent (direct actor tool)',
        { retry: 3 },
        async () => {
            let client: McpSuiteClient | undefined;
            try {
                client = await createClientFn({ tools: [ACTOR_NORMAL_MODE] });
                const taskClient = asLegacyClient(client);

                const api = new ApifyClient({ token: process.env.APIFY_TOKEN as string });
                const { onprogress, runIdPromise } = captureRunIdFromProgress();

                const stream = taskClient.experimental.tasks.callToolStream(
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
                        await taskClient.experimental.tasks.cancelTask(message.task.taskId);
                        cancelled = true;
                    } else if (message.type === 'result') {
                        throw new Error('Task should have been cancelled before completion');
                    }
                }
                expect(cancelled).toBe(true);

                const runId = await runIdPromise;
                await waitForRunAborted(api, runId);
            } finally {
                await client?.close();
            }
        },
    );

    it.runIf(hasTasksSupport)(
        'should support call-actor tool in task mode (internal tool with taskSupport)',
        async () => {
            let client: McpSuiteClient | undefined;
            try {
                client = await createClientFn({ tools: ['actors'] });
                const taskClient = asLegacyClient(client);

                const stream = taskClient.experimental.tasks.callToolStream(
                    {
                        name: HELPER_TOOLS.ACTOR_CALL,
                        arguments: {
                            actor: ACTOR_NORMAL_MODE,
                            input: {
                                firstNumber: 10,
                                secondNumber: 20,
                            },
                        },
                    },
                    CallToolResultSchema,
                    {
                        task: {
                            ttl: 60000, // Keep results for 60 seconds
                        },
                    },
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
                            // Task should transition through statuses
                            expect(['working', 'completed']).toContain(message.task.status);
                            break;
                        case 'result': {
                            // Verify the result contains expected content
                            const content = message.result.content as { text: string; type: string }[];
                            expect(content.length).toBeGreaterThan(0);
                            // Should contain dataset or run information
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
                await client?.close();
            }
        },
    );

    // WARNING: These tests can be flaky on streamable HTTP transport due to timing —
    // the Actor may complete before the progress polling interval (PROGRESS_NOTIFICATION_INTERVAL_MS)
    // fires a statusMessage. See: https://github.com/apify/apify-mcp-server/issues/558
    it.runIf(hasTasksSupport)(
        'should propagate statusMessage to tasks/get and tasks/list for internal tools in task mode',
        { retry: 1 },
        async () => {
            let client: McpSuiteClient | undefined;
            try {
                client = await createClientFn({ tools: ['actors'] });
                const taskClient = asLegacyClient(client);

                const stream = taskClient.experimental.tasks.callToolStream(
                    {
                        name: HELPER_TOOLS.ACTOR_CALL,
                        arguments: {
                            actor: ACTOR_NORMAL_MODE,
                            // waitSeconds keeps the run open long enough for the polling
                            // interval to emit at least one statusMessage notification.
                            input: { firstNumber: 1, secondNumber: 2, waitSeconds: 10 },
                        },
                    },
                    CallToolResultSchema,
                    {
                        task: {
                            ttl: 60000,
                        },
                    },
                );

                await assertStatusMessagePropagated(taskClient, stream);
            } finally {
                await client?.close();
            }
        },
    );

    it.runIf(hasTasksSupport)(
        'should propagate statusMessage to tasks/get and tasks/list for actor tools in task mode',
        { retry: 1 },
        async () => {
            let client: McpSuiteClient | undefined;
            try {
                client = await createClientFn({ tools: [ACTOR_NORMAL_MODE] });
                const taskClient = asLegacyClient(client);

                const stream = taskClient.experimental.tasks.callToolStream(
                    {
                        name: actorNameToToolName(ACTOR_NORMAL_MODE),
                        // waitSeconds keeps the run open long enough for the polling
                        // interval to emit at least one statusMessage notification.
                        arguments: { firstNumber: 1, secondNumber: 2, waitSeconds: 10 },
                    },
                    CallToolResultSchema,
                    {
                        task: {
                            ttl: 60000,
                        },
                    },
                );

                await assertStatusMessagePropagated(taskClient, stream);
            } finally {
                await client?.close();
            }
        },
    );
}
