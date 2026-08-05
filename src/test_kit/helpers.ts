import type { Client as ClientV1 } from '@modelcontextprotocol/sdk/client/index.js';
import type { Progress } from '@modelcontextprotocol/sdk/types.js';
import Ajv from 'ajv';
import { expect, vi } from 'vitest';

import type { ApifyClient } from '../apify_client.js';
import { defaults, HELPER_TOOLS } from '../const.js';
import { actorNameToToolName } from '../tools/actor_tool_naming.js';
import { getCategoryTools, getDefaultTools, toolCategoriesEnabledByDefault } from '../tools/index.js';
import type { SERVER_MODE, ToolEntry } from '../types.js';
import { APIFY_ACTOR_RUN_META_KEY } from '../utils/mcp.js';
import { getExpectedToolNamesByCategories } from '../utils/tool_categories_helpers.js';
import { AUTO_INJECTED_TOOLS } from '../utils/tools_loader.js';
import type { CaseCtx, SuiteClient } from './types.js';

/**
 * Shared by every `src/test_kit/cases/*.cases.ts` module: fixture constants, the `withClient`
 * client-lifecycle wrapper every simple case builds its `run` from, and cross-cutting assertion
 * helpers. Everything here is published behind the `./test-kit` export — `tests/integration/
 * suite.ts` (this repo's own runner) and `apify-mcp-server-internal` both import from here
 * instead of maintaining their own copies.
 */

// Fixture Actors from apify/mcp-server-test-actor (see DEVELOPMENT.md); apify-mcp-server-internal
// hardcodes these same names for its own tests against the identical live fixtures.
export const ACTOR_NORMAL_MODE = 'apify/normal-mode-test-actor';
export const ACTOR_EXAMPLE_MCP_SERVER = 'apify/example-mcp-server';

export const RETIRED_SELECTORS = ['add-actor', 'experimental', 'preview'] as const;
export const AUTO_INJECTED_TOOL_NAMES = AUTO_INJECTED_TOOLS.map((t) => t.name);
export const DEFAULT_ACTOR_NAMES = defaults.actors.map((actor) => actorNameToToolName(actor));

// Function to avoid circular dependency during module initialization.
export function getDefaultToolNames(): string[] {
    return getExpectedToolNamesByCategories(toolCategoriesEnabledByDefault);
}

// report-problem is telemetry-gated and lives in the dev category, so getDefaultTools
// (actors + docs) never contains it, and a telemetry-off suite would not be served it anyway.
// Its served/hidden/acknowledge behavior is covered by this repo's own unit tests.
export function servedDefaultTools(): ToolEntry[] {
    return getDefaultTools('default');
}
export function servedDefaultToolNames(): string[] {
    return getDefaultToolNames();
}

/** Builds a case's `run(ctx)` from client options + a testFn — creates the client, runs testFn, always closes. */
export function withClient(
    clientOptions: Parameters<CaseCtx['createClientFn']>[0],
    testFn: (client: SuiteClient) => Promise<void>,
): (ctx: CaseCtx) => Promise<void> {
    return async (ctx) => {
        const client = await ctx.createClientFn(clientOptions);
        try {
            await testFn(client);
        } finally {
            await client.close();
        }
    };
}

/**
 * Narrows a suite client to the v1 SDK client. Only for cases gated to the legacy dimensions:
 * the v2 client has no `experimental.tasks`, no v1 `transport`, and a different `request()` shape.
 */
export function asLegacyClient(client: SuiteClient): ClientV1 {
    return client as ClientV1;
}

export function getToolNames(tools: { tools: { name: string }[] }): string[] {
    return tools.tools.map((tool) => tool.name);
}

export function expectToolNamesToContain(names: string[], toolNames: string[] = []): void {
    toolNames.forEach((name) => expect(names).toContain(name));
}

export function buildExampleMcpServerAddToolContent(firstNumber: number, secondNumber: number) {
    return [
        {
            type: 'text' as const,
            text: `The sum of ${firstNumber} and ${secondNumber} is ${firstNumber + secondNumber}`,
        },
    ];
}

export function validateStructuredOutput(result: unknown, toolOutputSchema: unknown, toolName: string): void {
    const resultWithStructured = result as Record<string, unknown>;
    if (!resultWithStructured.structuredContent) return;

    const { structuredContent } = resultWithStructured;
    expect(toolOutputSchema).toBeDefined();

    if (toolOutputSchema) {
        const ajv = new Ajv();
        const validate = ajv.compile(toolOutputSchema as Record<string, unknown>);
        const isValid = validate(structuredContent);
        if (!isValid) {
            // eslint-disable-next-line no-console
            console.error(`Validation errors for ${toolName}:`, validate.errors);
        }
        expect(isValid).toBe(true);
        expect(validate.errors).toBeNull();
    }
}

/** Helper to find tool by name, resolving categories for the given mode on each call. */
export function findToolByName(name: string, mode: SERVER_MODE): ToolEntry | undefined {
    const resolved = getCategoryTools(mode);
    for (const tools of Object.values(resolved)) {
        const tool = tools.find((t) => t.name === name);
        if (tool) return tool;
    }
    return undefined;
}

export function validateStructuredOutputForTool(result: unknown, toolName: string, mode: SERVER_MODE): void {
    validateStructuredOutput(result, findToolByName(toolName, mode)?.outputSchema, toolName);
}

/**
 * Verify that structuredContent contains a non-empty readme and inputSchema.
 * Optionally checks actorInfo.fullName when expectedActorFullName is provided.
 */
export function expectReadmeInStructuredContent(result: unknown, expectedActorFullName?: string): void {
    const r = result as {
        structuredContent?: { actorInfo?: { fullName?: string }; readme?: string; inputSchema?: unknown };
    };
    expect(r.structuredContent).toBeDefined();
    if (expectedActorFullName) {
        expect(r.structuredContent?.actorInfo?.fullName).toBe(expectedActorFullName);
    }
    expect(r.structuredContent?.readme).toBeDefined();
    expect(typeof r.structuredContent?.readme).toBe('string');
    expect(r.structuredContent!.readme!.length).toBeGreaterThan(0);
    expect(r.structuredContent?.inputSchema).toBeDefined();
}

/** Validates that the listed tools have widget metadata (_meta) with MCP Apps ui.* keys. */
export function expectWidgetToolMeta(tools: { tools: { name: string; _meta?: Record<string, unknown> }[] }): void {
    const toolNames = [
        HELPER_TOOLS.STORE_SEARCH_WIDGET,
        HELPER_TOOLS.ACTOR_GET_DETAILS_WIDGET,
        HELPER_TOOLS.ACTOR_CALL_WIDGET,
    ];
    for (const toolName of toolNames) {
        const tool = tools.tools.find((t) => t.name === toolName);
        expect(tool).toBeDefined();
        expect(tool?._meta).toBeDefined();
        // MCP Apps standard keys (SEP-1865)
        const ui = tool?._meta?.ui as Record<string, unknown> | undefined;
        expect(ui).toBeDefined();
        expect(ui?.resourceUri).toBeDefined();
        expect(ui?.visibility).toEqual(['model', 'app']);
    }
}

/**
 * Validates the canonical run response from `call-actor` against the normal-mode-test-actor.
 * The response does not inline dataset items. `itemCount` is not asserted because Apify's
 * dataset metadata propagation can lag past the server's probe window; the dataset id plus a
 * non-empty `fields` list is the reliable signal that items were written.
 */
export function expectNormalModeTestStructuredContent(result: unknown): void {
    const resultWithStructured = result as {
        structuredContent?: {
            runId?: string;
            status?: string;
            apifyConsoleUrl?: string;
            storages?: {
                datasets?: { default?: { id?: string; fields?: string[]; apifyConsoleUrl?: string } };
                keyValueStores?: { default?: { apifyConsoleUrl?: string } };
            };
            summary?: string;
            nextStep?: string;
        };
        content?: { type: string; text?: string }[];
    };
    const sc = resultWithStructured.structuredContent;
    expect(sc).toBeDefined();
    expect(sc?.runId).toBeDefined();
    expect(sc?.status).toBe('SUCCEEDED');
    expect(sc?.storages?.datasets?.default?.id).toBeDefined();
    expect(sc?.storages?.datasets?.default?.fields ?? []).toEqual(
        expect.arrayContaining(['firstNumber', 'secondNumber', 'sum']),
    );
    expect(sc?.summary).toBeDefined();
    expect(sc?.nextStep).toBeDefined();

    // Console links are gated on a Console UI token (apify_ui_...); integration tests authenticate
    // with an API token, so the run/storage responses must carry no apifyConsoleUrl and no Console nudge.
    // The positive (UI-token) path is covered by unit tests — CI has no UI token to exercise it.
    expect(sc?.apifyConsoleUrl).toBeUndefined();
    expect(sc?.storages?.datasets?.default?.apifyConsoleUrl).toBeUndefined();
    expect(sc?.storages?.keyValueStores?.default?.apifyConsoleUrl).toBeUndefined();
    const narrative = resultWithStructured.content?.map((c) => c.text ?? '').join('\n') ?? '';
    expect(narrative).not.toContain('Apify Console:');
}

/** Validates that the result contains Apify usage cost metadata with expected structure. */
export function expectUsageCostMeta(result: unknown): void {
    const resultWithMeta = result as {
        _meta?: { 'com.apify/ActorRun'?: { usageTotalUsd?: number; usageUsd?: Record<string, number> } };
    };
    expect(resultWithMeta._meta).toBeDefined();
    const actorRun = resultWithMeta._meta?.['com.apify/ActorRun'];
    expect(actorRun).toBeDefined();
    expect(typeof actorRun?.usageTotalUsd).toBe('number');
    expect(actorRun!.usageTotalUsd!).toBeGreaterThanOrEqual(0);
    const usageUsd = actorRun?.usageUsd;
    if (usageUsd !== undefined) {
        expect(typeof usageUsd).toBe('object');
    }
}

// --- Async-task helpers (notifications/cancelled, tasks/*) ---

const RUN_ABORT_WAIT_TIMEOUT_MS = 60_000;
const RUN_ABORT_WAIT_INTERVAL_MS = 500;
const RUN_ID_PROGRESS_TIMEOUT_MS = 10_000;

/**
 * Resolves runIdPromise from the first notifications/progress message. Caller awaits it before
 * aborting/cancelling, so there's no race with the run starting and no run-list polling.
 */
export function captureRunIdFromProgress(): {
    onprogress: (progress: Progress) => void;
    runIdPromise: Promise<string>;
} {
    let resolveRunId: (runId: string) => void;
    const captured = new Promise<string>((resolve) => {
        resolveRunId = resolve;
    });
    const onprogress = (progress: Progress) => {
        // Progress type omits _meta, but it's there at runtime (SDK spreads full params).
        const meta = (progress as Progress & { _meta?: Record<string, unknown> })._meta;
        const runId = (meta?.[APIFY_ACTOR_RUN_META_KEY] as { runId?: string } | undefined)?.runId;
        if (runId) resolveRunId(runId);
    };
    const runIdPromise = Promise.race([
        captured,
        new Promise<string>((_, reject) => {
            const timer = setTimeout(
                () =>
                    reject(
                        new Error(
                            `No runId observed via notifications/progress within ${RUN_ID_PROGRESS_TIMEOUT_MS}ms`,
                        ),
                    ),
                RUN_ID_PROGRESS_TIMEOUT_MS,
            );
            timer.unref();
            void captured.then(() => clearTimeout(timer));
        }),
    ]);
    return { onprogress, runIdPromise };
}

/** Poll a specific run by ID until it reaches ABORTED or ABORTING. */
export async function waitForRunAborted(apiClient: ApifyClient, runId: string): Promise<void> {
    await vi.waitUntil(
        async () => {
            const run = await apiClient.run(runId).get();
            return run?.status === 'ABORTED' || run?.status === 'ABORTING';
        },
        { timeout: RUN_ABORT_WAIT_TIMEOUT_MS, interval: RUN_ABORT_WAIT_INTERVAL_MS },
    );
}

type TaskStreamMessage = {
    type: string;
    task?: { taskId: string; statusMessage?: string };
    error?: Error;
};

export async function assertStatusMessagePropagated(
    taskClient: ClientV1,
    stream: AsyncIterable<TaskStreamMessage>,
): Promise<void> {
    let taskId: string | null = null;
    let getTaskSawStatusMessage = false;
    let listTasksSawStatusMessage = false;

    for await (const message of stream) {
        if (message.type === 'taskCreated') {
            taskId = message.task!.taskId;
        } else if (message.type === 'taskStatus') {
            if (message.task?.statusMessage) {
                getTaskSawStatusMessage = true;
                if (!listTasksSawStatusMessage && taskId) {
                    const currentTaskId = taskId;
                    const tasksList = await taskClient.experimental.tasks.listTasks();
                    const currentTask = tasksList.tasks.find((task) => task.taskId === currentTaskId);
                    if (currentTask?.statusMessage) listTasksSawStatusMessage = true;
                }
            }
        } else if (message.type === 'error') {
            throw message.error;
        }
    }

    expect(getTaskSawStatusMessage).toBe(true);
    expect(listTasksSawStatusMessage).toBe(true);
}
