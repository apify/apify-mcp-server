import type { Client as ClientV1 } from '@modelcontextprotocol/sdk/client/index.js';
import type { Progress } from '@modelcontextprotocol/sdk/types.js';
import Ajv from 'ajv';
import { expect, vi } from 'vitest';

import type { ApifyClient } from '@apify/actors-mcp-server/internals.js';
import {
    actorNameToToolName,
    defaults,
    getCategoryTools,
    getDefaultTools,
    getExpectedToolNamesByCategories,
} from '@apify/actors-mcp-server/internals.js';
import type { SERVER_MODE, ToolEntry } from '@apify/actors-mcp-server/internals/test-kit.js';
import {
    APIFY_ACTOR_RUN_META_KEY,
    AUTO_INJECTED_TOOLS,
    HELPER_TOOLS,
    toolCategoriesEnabledByDefault,
} from '@apify/actors-mcp-server/internals/test-kit.js';

import type { CaseCtx, SuiteClient } from './types.js';

// Live fixtures from apify/mcp-server-test-actor (see DEVELOPMENT.md).
export const ACTOR_NORMAL_MODE = 'apify/normal-mode-test-actor';
export const ACTOR_EXAMPLE_MCP_SERVER = 'apify/example-mcp-server';

export const RETIRED_SELECTORS = ['add-actor', 'experimental', 'preview'] as const;
export const AUTO_INJECTED_TOOL_NAMES = AUTO_INJECTED_TOOLS.map((t) => t.name);
export const DEFAULT_ACTOR_NAMES = defaults.actors.map((actor) => actorNameToToolName(actor));

// Lazy: avoids circular import during module init.
export function getDefaultToolNames(): string[] {
    return getExpectedToolNamesByCategories(toolCategoriesEnabledByDefault);
}

// report-problem is telemetry-gated (dev category); unit tests cover serve/hide/ack.
export function servedDefaultTools(): ToolEntry[] {
    return getDefaultTools('default');
}
export function servedDefaultToolNames(): string[] {
    return getDefaultToolNames();
}

/** Create client, run testFn, always close. */
export function withClient(
    clientOptions: Parameters<CaseCtx['createClientFn']>[0],
    testFn: (client: SuiteClient, ctx: CaseCtx) => Promise<void>,
): (ctx: CaseCtx) => Promise<void> {
    return async (ctx) => {
        const client = await ctx.createClientFn(clientOptions);
        try {
            await testFn(client, ctx);
        } finally {
            await client.close();
        }
    };
}

/** Cast to v1 SDK client (legacy dimensions only). */
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

/** Find tool by name for the given mode. */
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

/** Assert non-empty readme + inputSchema; optional actorInfo.fullName. */
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

/** Assert apps-mode widget tools carry MCP Apps `_meta.ui` (SEP-1865). */
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
        const ui = tool?._meta?.ui as Record<string, unknown> | undefined;
        expect(ui).toBeDefined();
        expect(ui?.resourceUri).toBeDefined();
        expect(ui?.visibility).toEqual(['model', 'app']);
    }
}

/**
 * Assert canonical normal-mode-test-actor run response.
 * Skips `itemCount` (dataset metadata can lag); requires dataset id + fields.
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

    // API-token clients get no Console URLs; UI-token path is unit-tested.
    expect(sc?.apifyConsoleUrl).toBeUndefined();
    expect(sc?.storages?.datasets?.default?.apifyConsoleUrl).toBeUndefined();
    expect(sc?.storages?.keyValueStores?.default?.apifyConsoleUrl).toBeUndefined();
    const narrative = resultWithStructured.content?.map((c) => c.text ?? '').join('\n') ?? '';
    expect(narrative).not.toContain('Apify Console:');
}

/** Assert Apify usage-cost `_meta` shape. */
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

const RUN_ABORT_WAIT_TIMEOUT_MS = 60_000;
const RUN_ABORT_WAIT_INTERVAL_MS = 500;
const RUN_ID_PROGRESS_TIMEOUT_MS = 10_000;

/** Capture runId from the first notifications/progress message. */
export function captureRunIdFromProgress(): {
    onprogress: (progress: Progress) => void;
    runIdPromise: Promise<string>;
} {
    let resolveRunId: (runId: string) => void;
    const captured = new Promise<string>((resolve) => {
        resolveRunId = resolve;
    });
    const onprogress = (progress: Progress) => {
        // Progress type omits _meta; present at runtime.
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
