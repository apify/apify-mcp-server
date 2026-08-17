import { parse } from 'node:querystring';

import type { TaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/interfaces.js';
import type { ApifyClient } from 'apify-client';

import log from '@apify/log';

import { processInput } from '../input.js';
import type { ActorStore, Input } from '../types.js';
import { SERVER_MODE } from '../types.js';
import { loadToolsFromInput } from '../utils/tools_loader.js';

/**
 * If the URL contains an `actors` query parameter, returns tools for those Actors; otherwise null.
 * @param url The URL to process
 * @param apifyClient The Apify client instance
 * @param mode Server mode for tool variant resolution
 * @param actorStore Optional store used to enrich direct actor tools' outputSchema with per-Actor itemsSchema.
 */
export async function processParamsGetTools(
    url: string,
    apifyClient: ApifyClient,
    mode: SERVER_MODE = SERVER_MODE.DEFAULT,
    actorStore?: ActorStore,
) {
    const input = parseInputParamsFromUrl(url);
    return await loadToolsFromInput(input, apifyClient, mode, actorStore);
}

export function parseInputParamsFromUrl(url: string): Input {
    const query = url.split('?')[1] || '';
    const params = parse(query);
    delete params.enableAddingActors;
    delete params.enableActorAutoLoading;
    return processInput(params as unknown as Input);
}

/**
 * Detects the task store's "task is gone" error. A long-running task whose TTL elapsed before its
 * result could be stored makes `storeTaskResult`/`updateTaskStatus` throw — the in-memory SDK store
 * says "Task with ID <id> not found", the hosted RedisTaskStore appends " or expired". This is a
 * benign terminal condition (the client gave up before we finished), not an unexpected failure.
 */
export function isTaskNotFoundError(error: unknown): boolean {
    return error instanceof Error && /^Task with ID .+ not found/.test(error.message);
}

/**
 * Stores a task result, skipping the store if the task expired before storage. On an expired/gone
 * task the store throws {@link isTaskNotFoundError}; that is benign (the client gave up), so it is
 * logged as softFail and swallowed instead of propagating. The caller can then still finish its
 * telemetry. Any other store error is rethrown.
 */
export async function storeTaskResultOrSkipIfExpired(
    taskStore: TaskStore,
    toolName: string,
    taskId: Parameters<TaskStore['storeTaskResult']>[0],
    status: Parameters<TaskStore['storeTaskResult']>[1],
    result: Parameters<TaskStore['storeTaskResult']>[2],
    mcpSessionId?: Parameters<TaskStore['storeTaskResult']>[3],
): Promise<void> {
    try {
        await taskStore.storeTaskResult(taskId, status, result, mcpSessionId);
    } catch (error) {
        if (!isTaskNotFoundError(error)) throw error;
        log.softFail('Task expired before its result could be stored', { taskId, toolName, mcpSessionId });
    }
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
 * The SDK's `tasks/cancel` handler only writes `status='cancelled'` to the store — it does not
 * abort the in-flight request's `AbortController`. Without this watcher the Actor run keeps
 * consuming compute until it finishes naturally. The signal reaches `waitForRunWithProgress`,
 * whose `raceAbort` invokes `abortRunOnSignal` → `apifyClient.run(runId).abort()`.
 *
 * Two deliberate choices:
 *
 * - **The request's `extra.signal` is NOT chained.** Per the tasks spec a task's lifetime is
 *   decoupled from the request that created it: client disconnect, transport close, or
 *   `notifications/cancelled` on the original request MUST NOT cancel the task. Only
 *   `tasks/cancel` may. Regression guard: the `does not abort when an unrelated AbortSignal
 *   fires` case in `tests/unit/mcp.utils.test.ts`.
 * - **Polling, not a callback.** In multi-node deployments `tasks/cancel` can land on a
 *   different pod than the one running the handler; the `AbortController` lives in that pod's
 *   memory. The shared TaskStore is the only signal the executing pod can observe, so it must
 *   poll. 500 ms trades cancel latency against store load.
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
    let tickInProgress = false;
    const interval = setInterval(() => {
        if (tickInProgress || controller.signal.aborted) return;
        tickInProgress = true;
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
                tickInProgress = false;
            }
        })();
    }, pollIntervalMs);

    return {
        signal: controller.signal,
        dispose: () => clearInterval(interval),
    };
}
