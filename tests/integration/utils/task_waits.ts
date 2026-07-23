import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Progress } from '@modelcontextprotocol/sdk/types.js';
import type { ApifyClient } from 'apify-client';
import { expect, vi } from 'vitest';

import { APIFY_ACTOR_RUN_META_KEY } from '../../../src/utils/mcp.js';
import { TERMINAL_RUN_STATUSES } from '../../../src/utils/progress.js';

// Generous timeout: container-scheduling lag on the Apify Platform can push "ABORTED status
// propagates" past the tight bound the original value assumed, surfacing as `Timed out in
// waitUntil` flakes on otherwise-correct test logic.
const RUN_ABORT_WAIT_TIMEOUT_MS = 60_000;
const RUN_ABORT_WAIT_INTERVAL_MS = 500;

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
 * Resolves runIdPromise from the first notifications/progress message (works for plain requests
 * and task-augmented calls — pass `onprogress` alongside `task` too). The caller awaits it before
 * aborting/cancelling, so there's no race with the run starting and no run-list polling.
 */
export function captureRunIdFromProgress(): {
    onprogress: (progress: Progress) => void;
    runIdPromise: Promise<string>;
} {
    let resolveRunId: (runId: string) => void;
    const runIdPromise = new Promise<string>((resolve) => {
        resolveRunId = resolve;
    });
    const onprogress = (progress: Progress) => {
        // Progress type omits _meta, but it's there at runtime (SDK spreads full params).
        const meta = (progress as Progress & { _meta?: Record<string, unknown> })._meta;
        const runId = (meta?.[APIFY_ACTOR_RUN_META_KEY] as { runId?: string } | undefined)?.runId;
        if (runId) resolveRunId(runId);
    };
    return { onprogress, runIdPromise };
}

/**
 * Poll a specific run by ID until it reaches ABORTED or ABORTING.
 * Pair with `captureRunIdFromProgress` for deterministic abort verification.
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
