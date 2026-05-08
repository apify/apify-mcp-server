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
 * Creates an AbortSignal that fires only when an MCP task is cancelled
 * via the TaskStore — i.e. the client explicitly called `tasks/cancel`.
 *
 * Why this exists. The SDK's `tasks/cancel` handler only writes
 * `status='cancelled'` to the TaskStore (see @modelcontextprotocol/sdk
 * shared/protocol.js — CancelTaskRequestSchema handler). It does NOT abort
 * the in-flight request's AbortController. Without this watcher, calling
 * `tasks/cancel` would flip the task status but the tool handler would
 * keep running and the underlying Apify Actor run would keep consuming
 * compute until natural completion.
 *
 * Why the request's `extra.signal` is intentionally NOT chained. Per the
 * MCP tasks spec, a task's lifetime is decoupled from the original
 * request: once `{ task }` is returned, the request is complete and the
 * task continues independently. Client disconnect, `notifications/cancelled`
 * for the original request ID, or any other request-level abort MUST
 * NOT cancel the task — the only valid cancel path is `tasks/cancel`,
 * which goes through the TaskStore. Chaining `extra.signal` here would
 * silently violate that contract.
 *
 * Why polling, not a callback. In multi-node deployments (the hosted Apify
 * MCP server runs on multiple pods sharing one Redis-backed TaskStore),
 * `tasks/cancel` may arrive on a different node than the one running the
 * handler. The shared TaskStore is the only signal the executing node can
 * observe — so it must poll. 500 ms is a deliberate compromise between
 * cancellation latency and Redis load.
 *
 * Returns `{ signal, dispose }`. Callers MUST call `dispose()` to stop the
 * polling interval; otherwise it leaks for the lifetime of the process.
 */
export function createTaskCancellationWatcher(opts: {
    taskId: string;
    mcpSessionId: string | undefined;
    taskStore: TaskStore;
    pollIntervalMs?: number;
}): { signal: AbortSignal; dispose: () => void } {
    const { taskId, mcpSessionId, taskStore, pollIntervalMs = 500 } = opts;
    const controller = new AbortController();

    // `tickInFlight` prevents tick overlap when `getTask` is slower than the
    // poll interval (Redis tail latency, cluster reslot). Without it, ticks
    // pile up and amplify backend load right when the backend is struggling.
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
                    controller.abort(new Error(`Task ${taskId} cancelled by client`));
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
