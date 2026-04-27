import { parse } from 'node:querystring';

import type { TaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/interfaces.js';
import type { Result } from '@modelcontextprotocol/sdk/types.js';
import type { ApifyClient } from 'apify-client';

import { processInput } from '../input.js';
import type { ActorStore, Input, ServerMode } from '../types.js';
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
    mode: ServerMode = 'default',
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
 * Stores a task result with a final statusMessage in one logical step.
 *
 * WARNING: This is NOT atomic. The SDK's storeTaskResult() does not accept a statusMessage,
 * so we first call updateTaskStatus('working', message) then storeTaskResult(status, result).
 * That creates a race: after the tool has already finished, tasks/cancel can still win before
 * storeTaskResult() runs, and the computed result is lost. We keep this workaround so tasks/list
 * shows the final statusMessage until the SDK supports atomic result + statusMessage storage.
 */
export async function storeTaskResultWithMessage(
    taskStore: TaskStore,
    taskId: string,
    // Always 'completed' — the SDK's requestStream() only delivers results for 'completed' tasks;
    // 'failed' tasks yield a generic error and discard the stored result. See res/task_status_workaround.md.
    status: 'completed',
    result: Result,
    statusMessage: string,
    sessionId?: string,
): Promise<void> {
    await taskStore.updateTaskStatus(taskId, 'working', statusMessage, sessionId);
    await taskStore.storeTaskResult(taskId, status, result, sessionId);
}
