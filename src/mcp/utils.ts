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
 * Polls the TaskStore and returns a signal that aborts only when an MCP task
 * is cancelled via `tasks/cancel`. Caller MUST invoke `dispose()` once the
 * tool handler returns or the polling interval leaks.
 *
 * See {@link ../../res/tasks_cancel_abort_flow.md} for the full design:
 * why the request's `extra.signal` is intentionally NOT chained, why polling
 * (not a callback), and how it composes with the existing handler-side abort.
 */
export function createTaskCancellationWatcher(opts: {
    taskId: string;
    mcpSessionId: string | undefined;
    taskStore: TaskStore;
    pollIntervalMs?: number;
}): { signal: AbortSignal; dispose: () => void } {
    const { taskId, mcpSessionId, taskStore, pollIntervalMs = 500 } = opts;
    const controller = new AbortController();

    // Prevents tick overlap when `getTask` is slower than the poll interval (Redis tail
    // latency, cluster reslot). Without it, ticks pile up and amplify backend load right
    // when the backend is struggling.
    let tickInFlight = false;
    const interval = setInterval(() => {
        if (tickInFlight || controller.signal.aborted) return;
        tickInFlight = true;
        void (async () => {
            try {
                if (await isTaskCancelled(taskId, mcpSessionId, taskStore)) {
                    // Stop the timer immediately rather than relying on dispose() —
                    // otherwise ticks keep firing as no-ops until the caller's
                    // finally block runs.
                    clearInterval(interval);
                    controller.abort();
                }
            } catch {
                // In production `taskStore.getTask` hits Redis. Swallow transient failures so they don't crash the pod via
                // unhandled rejection; the next successful tick will still detect cancellation. Not logged: under sustained Redis
                // degradation this fires every pollIntervalMs per task and would flood logs.
            } finally {
                tickInFlight = false;
            }
        })();
    }, pollIntervalMs);

    return {
        signal: controller.signal,
        dispose: () => clearInterval(interval),
    };
}
