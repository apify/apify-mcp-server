import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ApifyClient } from 'apify-client';
import { expect, vi } from 'vitest';

type TaskStreamMessage = {
    type: string;
    task?: {
        taskId: string;
        statusMessage?: string;
    };
    error?: Error;
};

export async function assertStatusMessagePropagated(
    taskClient: Client,
    stream: AsyncIterable<TaskStreamMessage>,
) {
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

export async function waitForActorRunAbortStatus(
    apiClient: ApifyClient,
    actorId: string,
) {
    // Apify run state propagation can take >10s under load; budget more time so the
    // server-side abort has a fair chance of being observed before the test gives up.
    await vi.waitUntil(async () => {
        const runsList = await apiClient.runs().list({ limit: 5, desc: true });
        const currentRun = runsList.items.find((run) => run.actId === actorId);
        if (!currentRun) {
            return false;
        }
        return currentRun.status === 'ABORTED' || currentRun.status === 'ABORTING';
    }, { timeout: 30000, interval: 500 });
}
