import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ApifyClient } from 'apify-client';
import { expect, vi } from 'vitest';

import { TERMINAL_RUN_STATUSES } from '../../../src/utils/progress.js';

// Generous timeouts: container-scheduling lag on the Apify Platform can push
// "first time the run shows up in the API" or "ABORTED status propagates" past
// the tight bounds the original values assumed, surfacing as `Timed out in
// waitUntil` flakes on otherwise-correct test logic.
const RUN_DISCOVERY_TIMEOUT_MS = 20_000;
const RUN_DISCOVERY_INTERVAL_MS = 250;
const RUN_ABORT_WAIT_TIMEOUT_MS = 60_000;
const RUN_ABORT_WAIT_INTERVAL_MS = 500;
// `startedAt` is server-stamped; `capturingSince` is client-stamped — buffer absorbs skew.
const CLOCK_SKEW_BUFFER_MS = 2_000;

type TaskStreamMessage = {
    type: string;
    task?: {
        taskId: string;
        statusMessage?: string;
    };
    error?: Error;
};

export async function assertStatusMessagePropagated(taskClient: Client, stream: AsyncIterable<TaskStreamMessage>) {
    let taskId: string | null = null;
    let getTaskSawStatusMessage = false;
    let listTasksSawStatusMessage = false;

    for await (const message of stream) {
        if (message.type === 'taskCreated') {
            taskId = message.task!.taskId;
        } else if (message.type === 'taskStatus') {
            if (message.task?.statusMessage) {
                getTaskSawStatusMessage = true;

                // Verify tasks/list also includes statusMessage (one-time check)
                if (!listTasksSawStatusMessage && taskId) {
                    const currentTaskId = taskId;
                    const tasksList = await taskClient.experimental.tasks.listTasks();
                    const currentTask = tasksList.tasks.find((task) => task.taskId === currentTaskId);
                    if (currentTask?.statusMessage) {
                        listTasksSawStatusMessage = true;
                    }
                }
            }
        } else if (message.type === 'error') {
            throw message.error;
        }
    }

    // Stream taskStatus events (backed by tasks/get) must have included statusMessage.
    expect(getTaskSawStatusMessage).toBe(true);
    // tasks/list must have also returned statusMessage.
    expect(listTasksSawStatusMessage).toBe(true);
}

/**
 * Race the Apify API to find the just-started run for this Actor under the test's token.
 *
 * Cancellation tests need the runId to verify the abort side-effect, but the runId
 * isn't reachable through the MCP client — the response isn't delivered after cancel,
 * and `notifications/progress` doesn't carry it. The run does appear in the Actor-scoped
 * run list within a few hundred ms of server-side `start()`.
 *
 * Scoped to THIS Actor (not global `runs()`) so concurrent runs of other Actors don't
 * pollute the page. Non-terminal status filter excludes prior completed runs in the window.
 */
export async function captureInflightActorRunId(
    apiClient: ApifyClient,
    actorId: string,
    capturingSince: Date,
): Promise<string> {
    const startedAfter = new Date(capturingSince.getTime() - CLOCK_SKEW_BUFFER_MS);
    const runId = await vi.waitUntil(
        async () => {
            const runs = await apiClient.actor(actorId).runs().list({ limit: 3, desc: true });
            return runs.items.find(
                (r) =>
                    r.startedAt instanceof Date && r.startedAt >= startedAfter && !TERMINAL_RUN_STATUSES.has(r.status),
            )?.id;
        },
        { timeout: RUN_DISCOVERY_TIMEOUT_MS, interval: RUN_DISCOVERY_INTERVAL_MS },
    );
    return runId as string;
}

/**
 * Poll a specific run by ID until it reaches ABORTED or ABORTING.
 * Pair with `captureInflightActorRunId` for deterministic abort verification.
 */
export async function waitForRunAborted(apiClient: ApifyClient, runId: string): Promise<void> {
    await vi.waitUntil(
        async () => {
            const run = await apiClient.run(runId).get();
            return run?.status === 'ABORTED' || run?.status === 'ABORTING';
        },
        { timeout: RUN_ABORT_WAIT_TIMEOUT_MS, interval: RUN_ABORT_WAIT_INTERVAL_MS },
    );
}

const RUN_TERMINAL_WAIT_TIMEOUT_MS = 90_000;
const RUN_TERMINAL_WAIT_INTERVAL_MS = 1_000;

/**
 * Poll a specific run by ID until it reaches a terminal status (SUCCEEDED / FAILED /
 * ABORTED / TIMED-OUT). Useful when a test needs to read the run's dataset items
 * but the `call-actor` / direct-actor-tool call returned with status RUNNING because
 * `waitSecs` (capped at 45) elapsed before the actor finished.
 */
export async function waitForRunTerminal(apiClient: ApifyClient, runId: string): Promise<void> {
    await vi.waitUntil(
        async () => {
            const run = await apiClient.run(runId).get();
            return run && TERMINAL_RUN_STATUSES.has(run.status);
        },
        { timeout: RUN_TERMINAL_WAIT_TIMEOUT_MS, interval: RUN_TERMINAL_WAIT_INTERVAL_MS },
    );
}
