import { parse } from 'node:querystring';

import type { TaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/interfaces.js';
import type { ApifyClient } from 'apify-client';

import { processInput } from '../input.js';
import type { ActorStore, Input } from '../types.js';
import { ServerMode } from '../types.js';
import { loadToolsFromInput } from '../utils/tools_loader.js';

/**
 * Process input parameters from URL and get tools
 * If URL contains query parameter `actors`, return tools from Actors otherwise return null.
 * @param url The URL to process
 * @param apifyClient The Apify client instance
 * @param mode Server mode for tool variant resolution
 * @param actorStore
 */
export async function processParamsGetTools(
    url: string,
    apifyClient: ApifyClient,
    mode: ServerMode = ServerMode.DEFAULT,
    actorStore?: ActorStore,
) {
    const input = parseInputParamsFromUrl(url);
    return await loadToolsFromInput(input, apifyClient, mode, actorStore);
}

export function parseInputParamsFromUrl(url: string): Input {
    const query = url.split('?')[1] || '';
    const params = parse(query) as unknown as Input;
    return processInput(params);
}

/**
 * Checks if a task was cancelled, preventing state transitions from terminal states.
 * Critical for task execution: prevents SDK errors when trying to transition from 'cancelled' to 'working'.
 * @param taskId - The task identifier
 * @param mcpSessionId - The MCP session ID
 * @param taskStore - The task store instance
 * @returns true if task is cancelled, false otherwise
 */
export async function isTaskCancelled(
    taskId: string,
    mcpSessionId: string | undefined,
    taskStore: TaskStore,
): Promise<boolean> {
    const task = await taskStore.getTask(taskId, mcpSessionId);
    return task?.status === 'cancelled';
}

/**
 * Returns a signal that aborts when either the parent signal aborts or the task store
 * reports the task as `cancelled`. Caller must invoke `dispose()` to stop polling.
 * Without this, the transport signal would not fire on `tasks/cancel` and the in-flight
 * tool handler would keep running until natural completion.
 */
export function chainTaskStoreCancellation(opts: {
    parentSignal: AbortSignal;
    taskId: string;
    mcpSessionId: string | undefined;
    taskStore: TaskStore;
    pollIntervalMs?: number;
}): { signal: AbortSignal; dispose: () => void } {
    const { parentSignal, taskId, mcpSessionId, taskStore, pollIntervalMs = 500 } = opts;
    const controller = new AbortController();
    const onParentAbort = () => controller.abort(parentSignal.reason);

    if (parentSignal.aborted) {
        controller.abort(parentSignal.reason);
    } else {
        parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }

    const interval = setInterval(() => {
        void (async () => {
            if (controller.signal.aborted) return;
            if (await isTaskCancelled(taskId, mcpSessionId, taskStore)) {
                controller.abort(new Error(`Task ${taskId} cancelled by client`));
            }
        })();
    }, pollIntervalMs);

    return {
        signal: controller.signal,
        dispose: () => {
            clearInterval(interval);
            parentSignal.removeEventListener('abort', onParentAbort);
        },
    };
}
