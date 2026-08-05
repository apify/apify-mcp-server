import { expect, it } from 'vitest';

import { defaults, HELPER_TOOLS } from '../../../src/const.js';
import { registerScenarios } from '../../../src/test_kit/index.js';
import { actorNameToToolName } from '../../../src/tools/actor_tool_naming.js';
// Import tools from getCategoryTools instead of directly to avoid circular dependency during module initialization
import { getCategoryTools } from '../../../src/tools/index.js';
import type { ToolCategory } from '../../../src/types.js';
import { getExpectedToolNamesByCategories } from '../../../src/utils/tool_categories_helpers.js';
import { ACTOR_NORMAL_MODE, DEFAULT_ACTOR_NAMES } from '../../const.js';
import type { McpSuiteClient } from '../../helpers.js';
import {
    AUTO_INJECTED_TOOL_NAMES,
    type CasesCtx,
    expectToolNamesToContain,
    expectWidgetToolMeta,
    getToolNames,
    RETIRED_SELECTORS,
    servedDefaultTools,
    servedDefaultToolNames,
} from './shared.js';
import { registrationCriticalScenarios } from './shared_scenarios.js';

/**
 * Tool-loading mechanics: which tools/Actors get served for a given `tools`/`actors`
 * selector combination, category expansion, retired-selector dropping, env-var loading
 * (stdio), auto-injected storage/abort ordering, and server-mode (`?ui=`) selection.
 */
export function registerRegistrationCases(ctx: CasesCtx): void {
    const { itc, createClientFn, transport, hasTasksSupport } = ctx;

    // Shared with apify-mcp-server-internal via @apify/actors-mcp-server/test-kit — single
    // source of truth for these two, see tests/integration/cases/shared_scenarios.ts.
    registerScenarios('registration (shared)', registrationCriticalScenarios, {
        createClientFn,
    });

    itc(
        'should match spec default: actors,docs,apify/rag-web-browser when no params provided',
        undefined,
        async (client) => {
            const tools = await client.listTools();
            const names = getToolNames(tools);

            // Should be equivalent to tools=actors,docs,apify/rag-web-browser
            // Note: UI tools (search-actors-widget, fetch-actor-details-widget) are only available in apps mode
            // report-problem is telemetry-gated and telemetry is off in this suite, so it is not listed.
            const expectedActorsTools = ['fetch-actor-details', 'search-actors', 'call-actor'];
            const expectedDocsTools = ['search-apify-docs', 'fetch-apify-docs'];
            const expectedActors = [actorNameToToolName('apify/rag-web-browser')];

            const expectedTotal = expectedActorsTools.concat(expectedDocsTools, expectedActors);
            expect(names).toHaveLength(expectedTotal.length + 4);

            expectToolNamesToContain(names, expectedActorsTools);
            expectToolNamesToContain(names, expectedDocsTools);
            expect(names).not.toContain(HELPER_TOOLS.PROBLEM_REPORT);
            expectToolNamesToContain(names, expectedActors);
            expectToolNamesToContain(names, AUTO_INJECTED_TOOL_NAMES);
            // get-actor-run should be automatically included when call-actor is present
            expect(names).toContain(HELPER_TOOLS.ACTOR_RUNS_GET);
        },
    );

    itc('should list all default tools and Actors', undefined, async (client) => {
        const names = getToolNames(await client.listTools());
        expect(names.length).toEqual(servedDefaultTools().length + defaults.actors.length + 4);

        expectToolNamesToContain(names, servedDefaultToolNames());
        expectToolNamesToContain(names, DEFAULT_ACTOR_NAMES);
        expectToolNamesToContain(names, AUTO_INJECTED_TOOL_NAMES);
        // get-actor-run should be automatically included when call-actor is present
        expect(names).toContain(HELPER_TOOLS.ACTOR_RUNS_GET);
    });

    {
        const actors = ['apify/python-example', 'apify/rag-web-browser'];
        itc(
            'should list two loaded Actors plus auto-injected storage and abort tools',
            { actors, serverMode: 'default' },
            async (client) => {
                const names = getToolNames(await client.listTools());
                // Actor tools trigger auto-injected helpers (get-actor-run, storage, abort).
                expect(names.length).toEqual(actors.length + AUTO_INJECTED_TOOL_NAMES.length);
                expectToolNamesToContain(
                    names,
                    actors.map((actor) => actorNameToToolName(actor)),
                );
                expectToolNamesToContain(names, AUTO_INJECTED_TOOL_NAMES);
            },
        );
    }

    {
        const actors = [ACTOR_NORMAL_MODE];
        itc(
            'should load only specified actors when actors param is provided (no other tools)',
            { actors, serverMode: 'default' },
            async (client) => {
                const names = getToolNames(await client.listTools());

                // Should only load the specified actor plus auto-injected storage/abort helpers
                expect(names.length).toEqual(actors.length + AUTO_INJECTED_TOOL_NAMES.length);
                expect(names).toContain(actorNameToToolName(actors[0]));
                expectToolNamesToContain(names, AUTO_INJECTED_TOOL_NAMES);

                // Should NOT include any default category tools
                expect(names).not.toContain('search-actors');
                expect(names).not.toContain('fetch-actor-details');
                expect(names).not.toContain('call-actor');
                expect(names).not.toContain('search-apify-docs');
                expect(names).not.toContain('fetch-apify-docs');
            },
        );
    }

    {
        const actors = [ACTOR_NORMAL_MODE];
        itc(
            'should return tool with execution field when listing tools with apify/normal-mode-test-actor',
            { tools: actors },
            async (client) => {
                const tools = await client.listTools();

                // Find the tool for apify/normal-mode-test-actor
                const normalModeTool = tools.tools.find((tool) => tool.name === actorNameToToolName(ACTOR_NORMAL_MODE));
                expect(normalModeTool).toBeDefined();

                // Verify the tool contains the execution field (as returned by getToolPublicFieldOnly).
                // The 2026-07-28 codec strips `execution` as deleted vocabulary (no tasks capability there).
                if (hasTasksSupport) {
                    expect(normalModeTool).toHaveProperty('execution');
                    expect(normalModeTool?.execution).toBeDefined();
                } else {
                    expect(normalModeTool).not.toHaveProperty('execution');
                }

                // Verify other expected fields are present
                expect(normalModeTool).toHaveProperty('name');
                expect(normalModeTool).toHaveProperty('description');
                expect(normalModeTool).toHaveProperty('inputSchema');
            },
        );
    }

    itc('should not load any tools when tools param is empty', { tools: [] }, async (client) => {
        const names = getToolNames(await client.listTools());
        expect(names).toHaveLength(0);
    });

    itc('should not load any tools when actors param is empty', { actors: [] }, async (client) => {
        const names = getToolNames(await client.listTools());
        expect(names.length).toEqual(0);
    });

    itc(
        'should not load any tools when both tools and actors params are empty',
        { tools: [], actors: [] },
        async (client) => {
            const names = getToolNames(await client.listTools());
            expect(names.length).toEqual(0);
        },
    );

    {
        const actors = [ACTOR_NORMAL_MODE];
        itc(
            'should load only specified Actors via tools selectors when actors param omitted',
            { tools: actors, serverMode: 'default' },
            async (client) => {
                const names = getToolNames(await client.listTools());
                // The Actor plus auto-injected storage/abort helpers.
                expect(names).toHaveLength(actors.length + AUTO_INJECTED_TOOL_NAMES.length);
                expect(names).toContain(actorNameToToolName(actors[0]));
                expectToolNamesToContain(names, AUTO_INJECTED_TOOL_NAMES);
            },
        );
    }

    itc(
        'should treat selectors with slashes as Actor names',
        {
            tools: ['docs', ACTOR_NORMAL_MODE],
        },
        async (client) => {
            const names = getToolNames(await client.listTools());

            // Should include docs category
            expect(names).toContain('search-apify-docs');
            expect(names).toContain('fetch-apify-docs');

            // Should include actor (if it exists/is valid)
            expect(names).toContain(actorNameToToolName(ACTOR_NORMAL_MODE));
        },
    );

    {
        const actors = [ACTOR_NORMAL_MODE];
        const categories = ['docs'] as ToolCategory[];

        itc(
            'should merge actors param into tools selectors (backward compatibility)',
            { tools: categories, actors },
            async (client) => {
                const names = getToolNames(await client.listTools());
                const docsToolNames = getExpectedToolNamesByCategories(categories);
                const expected = [...docsToolNames, actorNameToToolName(actors[0])];
                // Actor tool triggers auto-injection of storage/abort helpers.
                expect(names).toHaveLength(expected.length + AUTO_INJECTED_TOOL_NAMES.length);

                const containsExpected = expected.every((n) => names.includes(n));
                expect(containsExpected).toBe(true);
                expectToolNamesToContain(names, AUTO_INJECTED_TOOL_NAMES);
            },
        );
    }

    itc(
        'loads docs while dropping retired selectors',
        {
            tools: ['docs', ...RETIRED_SELECTORS],
        },
        async (client) => {
            const names = getToolNames(await client.listTools());

            expect(names).toEqual([HELPER_TOOLS.DOCS_SEARCH, HELPER_TOOLS.DOCS_FETCH]);
        },
    );

    {
        const categories = ['docs'] as ToolCategory[];
        itc('should load only docs tools', { tools: categories, actors: [] }, async (client) => {
            const names = getToolNames(await client.listTools());
            const expected = getExpectedToolNamesByCategories(categories);
            expect(names.length).toEqual(expected.length);
            expectToolNamesToContain(names, expected);
        });
    }

    itc(
        'should load only a specific tool when tools includes a tool name',
        { tools: ['fetch-actor-details'], actors: [] },
        async (client) => {
            const names = getToolNames(await client.listTools());
            expect(names).toEqual(['fetch-actor-details']);
        },
    );

    itc('should not load any tools when tools param is empty and actors omitted', { tools: [] }, async (client) => {
        const names = getToolNames(await client.listTools());
        expect(names.length).toEqual(0);
    });

    itc(
        'should not load any internal tools when tools param is empty and use custom Actor if specified',
        { tools: [], actors: [ACTOR_NORMAL_MODE] },
        async (client) => {
            const names = getToolNames(await client.listTools());
            // Actor tool triggers auto-injected helpers (get-actor-run, storage, abort).
            expect(names.length).toEqual(1 + AUTO_INJECTED_TOOL_NAMES.length);
            expect(names).toContain(actorNameToToolName(ACTOR_NORMAL_MODE));
            expectToolNamesToContain(names, AUTO_INJECTED_TOOL_NAMES);
        },
    );

    // The `dev` category holds only report-problem, which is telemetry-gated (off in this suite),
    // so it can't load standalone here; its gating is covered by unit tests.
    it.for(Object.keys(getCategoryTools('default')).filter((category) => category !== 'dev'))(
        'should load correct tools for %s category',
        async (category) => {
            let client: McpSuiteClient | undefined;
            try {
                client = await createClientFn({
                    tools: [category as ToolCategory],
                });

                const loadedTools = await client.listTools();
                const toolNames = getToolNames(loadedTools);

                const expectedToolNames = getExpectedToolNamesByCategories([category as ToolCategory]);
                // Only assert that all tools from the selected category are present.
                for (const expectedToolName of expectedToolNames) {
                    expect(toolNames).toContain(expectedToolName);
                }
            } finally {
                await client?.close();
            }
        },
    );

    {
        const categories = ['docs', 'runs', 'storage'] as ToolCategory[];
        itc(
            'should handle multiple tool category keys input correctly',
            {
                tools: categories,
            },
            async (client) => {
                const loadedTools = await client.listTools();
                const toolNames = getToolNames(loadedTools);

                const expectedToolNames = getExpectedToolNamesByCategories(categories);
                expect(toolNames).toHaveLength(expectedToolNames.length);
                const containsExpectedTools = toolNames.every((name) => expectedToolNames.includes(name));
                expect(containsExpectedTools).toBe(true);
            },
        );
    }

    // Environment variable tests - only applicable to stdio transport
    it.runIf(transport === 'stdio')('should load actors from ACTORS environment variable', async () => {
        let client: McpSuiteClient | undefined;
        try {
            const actors = ['apify/python-example', 'apify/rag-web-browser'];
            client = await createClientFn({ actors, useEnv: true });
            const names = getToolNames(await client.listTools());
            expectToolNamesToContain(
                names,
                actors.map((actor) => actorNameToToolName(actor)),
            );
        } finally {
            await client?.close();
        }
    });

    it.runIf(transport === 'stdio')('should load tool categories from TOOLS environment variable', async () => {
        let client: McpSuiteClient | undefined;
        try {
            // Verifies env-var threading (`TOOLS=docs` → loader input) end-to-end via stdio.
            // `docs` is chosen because it doesn't trigger auto-inject — the loader's union/dedup
            // logic has its own unit coverage and isn't what this test should be asserting.
            client = await createClientFn({ tools: ['docs'], useEnv: true });
            const toolNames = getToolNames(await client.listTools());

            expect(toolNames).toContain(HELPER_TOOLS.DOCS_SEARCH);
            expect(toolNames).toContain(HELPER_TOOLS.DOCS_FETCH);
            expect(toolNames).not.toContain(HELPER_TOOLS.ACTOR_CALL);
            expect(toolNames).not.toContain(HELPER_TOOLS.ACTOR_RUNS_GET);
        } finally {
            await client?.close();
        }
    });

    itc('should auto-inject storage and abort tools after call-actor in expected order', undefined, async (client) => {
        const tools = await client.listTools();
        const names = tools.tools.map((t) => t.name);

        const callIndex = names.indexOf(HELPER_TOOLS.ACTOR_CALL);
        const runIndex = names.indexOf(HELPER_TOOLS.ACTOR_RUNS_GET);
        const datasetIndex = names.indexOf(HELPER_TOOLS.DATASET_GET_ITEMS);
        const kvIndex = names.indexOf(HELPER_TOOLS.KEY_VALUE_STORE_RECORD_GET);
        const abortIndex = names.indexOf(HELPER_TOOLS.ACTOR_RUNS_ABORT);

        expect(callIndex).toBeGreaterThanOrEqual(0);
        expect(callIndex).toBeLessThan(runIndex);
        expect(runIndex).toBeLessThan(datasetIndex);
        expect(datasetIndex).toBeLessThan(kvIndex);
        expect(kvIndex).toBeLessThan(abortIndex);
    });

    itc(
        'should not auto-inject storage and abort tools when no actor-touching tools are present',
        { tools: ['docs'] },
        async (client) => {
            const names = getToolNames(await client.listTools());
            for (const name of AUTO_INJECTED_TOOL_NAMES) expect(names).not.toContain(name);
            expect(names).not.toContain(HELPER_TOOLS.ACTOR_RUNS_GET);
        },
    );

    // Environment variable precedence tests
    it.runIf(transport === 'stdio')('should use TELEMETRY_ENABLED env var when CLI arg is not provided', async () => {
        let client: McpSuiteClient | undefined;
        try {
            // When useEnv=true, telemetry.enabled option translates to env.TELEMETRY_ENABLED in child process
            client = await createClientFn({ useEnv: true, telemetry: { enabled: false } });
            const tools = await client.listTools();

            // Verify tools are loaded correctly
            expect(tools.tools.length).toBeGreaterThan(0);
        } finally {
            await client?.close();
        }
    });

    // Uses the deprecated 'openai' alias deliberately to verify it is silently
    // normalized to 'apps' at the CLI/env ingestion boundary (no warning emitted).
    it.runIf(transport === 'stdio')(
        'should use UI_MODE env var (deprecated "openai" alias) when CLI arg is not provided',
        async () => {
            let client: McpSuiteClient | undefined;
            try {
                client = await createClientFn({ useEnv: true, serverMode: 'openai' });
                const tools = await client.listTools();
                const toolNames = getToolNames(tools);
                expect(tools.tools.length).toBeGreaterThan(0);

                // Verify that apps-only internal tools are present in apps mode
                expect(toolNames).toContain(HELPER_TOOLS.ACTOR_GET_DETAILS_WIDGET);
                expect(toolNames).toContain(HELPER_TOOLS.STORE_SEARCH_WIDGET);
                expect(toolNames).toContain(HELPER_TOOLS.ACTOR_CALL_WIDGET);

                // Verify that tools have widget metadata when UI mode is enabled
                expectWidgetToolMeta(tools);
            } finally {
                await client?.close();
            }
        },
    );

    itc('should enable apps mode when serverMode is apps', { serverMode: 'apps' }, async (client) => {
        const tools = await client.listTools();
        const toolNames = getToolNames(tools);
        expect(tools.tools.length).toBeGreaterThan(0);

        expect(toolNames).toContain(HELPER_TOOLS.ACTOR_GET_DETAILS_WIDGET);
        expect(toolNames).toContain(HELPER_TOOLS.STORE_SEARCH_WIDGET);
        expect(toolNames).toContain(HELPER_TOOLS.ACTOR_CALL_WIDGET);

        // Verify that tools have widget metadata when UI mode is enabled via URL parameter
        expectWidgetToolMeta(tools);
    });

    {
        // 'true' is the standard external value for ?ui= (maps to 'apps' internally via parseServerMode)
        itc('should treat serverMode=true the same as serverMode=apps', { serverMode: 'true' }, async (client) => {
            const tools = await client.listTools();
            const toolNames = getToolNames(tools);
            expect(tools.tools.length).toBeGreaterThan(0);

            expect(toolNames).toContain(HELPER_TOOLS.ACTOR_GET_DETAILS_WIDGET);
            expect(toolNames).toContain(HELPER_TOOLS.STORE_SEARCH_WIDGET);
            expect(toolNames).toContain(HELPER_TOOLS.ACTOR_CALL_WIDGET);
            expectWidgetToolMeta(tools);
        });
    }

    itc(
        'should automatically include get-actor-run for default settings when call-actor is enabled',
        { serverMode: 'apps' },
        async (client) => {
            const tools = await client.listTools();
            const toolNames = getToolNames(tools);

            // When serverMode is enabled, default tools include call-actor, so get-actor-run should be included
            expect(toolNames).toContain(HELPER_TOOLS.ACTOR_CALL);
            expect(toolNames).toContain(HELPER_TOOLS.ACTOR_RUNS_GET);
        },
    );

    itc(
        'should not include get-actor-run when only docs tools are selected',
        { serverMode: 'apps', tools: ['docs'] },
        async (client) => {
            const tools = await client.listTools();
            const toolNames = getToolNames(tools);

            // No actor tools selected — get-actor-run and its widget must not appear
            expect(toolNames).not.toContain(HELPER_TOOLS.ACTOR_RUNS_GET);
            expect(toolNames).not.toContain(HELPER_TOOLS.ACTOR_RUNS_GET_WIDGET);
            // Docs tools should be present
            expect(toolNames).toContain(HELPER_TOOLS.DOCS_SEARCH);
            expect(toolNames).toContain(HELPER_TOOLS.DOCS_FETCH);
            // call-actor should NOT be present since only 'docs' was selected
            expect(toolNames).not.toContain(HELPER_TOOLS.ACTOR_CALL);
        },
    );
}
