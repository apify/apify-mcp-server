import Ajv from 'ajv';
import { expect, it } from 'vitest';

import { HELPER_TOOLS } from '../../../src/const.js';
import { getCategoryTools, getDefaultTools } from '../../../src/tools/index.js';
import type { SERVER_MODE, ToolEntry } from '../../../src/types.js';
import { AUTO_INJECTED_TOOLS } from '../../../src/utils/tools_loader.js';
import { getDefaultToolNames } from '../../const.js';
import type { McpClientOptions, McpSuiteClient } from '../../helpers.js';

/**
 * Shared by every `tests/integration/cases/*.cases.ts` module: the client-creation contract
 * each transport dimension (stdio / streamable-http / 2026-07-28) implements, plus the
 * cross-cutting assertion helpers the split-out cases still need. Keeps `suite.ts` itself
 * down to hooks + wiring, one `register*Cases` call per file.
 */
export type CreateClientFn = (options?: McpClientOptions) => Promise<McpSuiteClient>;

export interface CasesCtx {
    /** Creates a client, runs `testFn`, and guarantees `client.close()` even on throw. */
    itc: (
        name: string,
        clientOptions: McpClientOptions | undefined,
        testFn: (client: McpSuiteClient) => Promise<void>,
    ) => void;
    createClientFn: CreateClientFn;
    transport: 'streamable-http' | 'stdio' | '2026-07-28';
    // The 2026-07-28 stateless adapter declares no `tasks` capability, so `tasks/*` is
    // method-not-found there — task-mode cases run on the legacy dimensions only.
    hasTasksSupport: boolean;
}

/** Builds the `itc` helper bound to one transport dimension's `createClientFn`. */
export function createItc(createClientFn: CreateClientFn): CasesCtx['itc'] {
    return (name, clientOptions, testFn) => {
        // thin wrapper: `name` is the caller's title string, and assertions live in the
        // caller's testFn, not here.
        // eslint-disable-next-line vitest/valid-title vitest/expect-expect
        it(name, async () => {
            const client = await createClientFn(clientOptions);
            try {
                await testFn(client);
            } finally {
                await client.close();
            }
        });
    };
}

export const AUTO_INJECTED_TOOL_NAMES = AUTO_INJECTED_TOOLS.map((t) => t.name);
export const RETIRED_SELECTORS = ['add-actor', 'experimental', 'preview'] as const;

// report-problem is telemetry-gated and lives in the dev category, so getDefaultTools
// (actors + docs) never contains it, and this telemetry-off suite would not be served it anyway.
// Its served/hidden/acknowledge behavior is covered by the unit tests
// (tests/unit/mcp.server.report_problem_gating.test.ts, tests/unit/tools.report_problem.test.ts).
export function servedDefaultTools(): ToolEntry[] {
    return getDefaultTools('default');
}
export function servedDefaultToolNames(): string[] {
    return getDefaultToolNames();
}

// Helper to find tool by name, resolving categories for the given mode on each call.
// This ensures we always validate against the correct mode-specific tool definition
// (e.g. outputSchema may diverge between modes in the future).
export function findToolByName(name: string, mode: SERVER_MODE): ToolEntry | undefined {
    const resolved = getCategoryTools(mode);
    for (const tools of Object.values(resolved)) {
        const tool = tools.find((t) => t.name === name);
        if (tool) return tool;
    }
    return undefined;
}

export function getToolNames(tools: { tools: { name: string }[] }) {
    return tools.tools.map((tool) => tool.name);
}

export function expectToolNamesToContain(names: string[], toolNames: string[] = []) {
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
    if (!resultWithStructured.structuredContent) {
        return;
    }

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

export function validateStructuredOutputForTool(result: unknown, toolName: string, mode: SERVER_MODE): void {
    validateStructuredOutput(result, findToolByName(toolName, mode)?.outputSchema, toolName);
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
