import { expect } from 'vitest';

import type { ToolCategory } from '@apify/actors-mcp-server/internals.js';
import {
    actorNameToToolName,
    defaults,
    getCategoryTools,
    getExpectedToolNamesByCategories,
} from '@apify/actors-mcp-server/internals.js';
import { HELPER_TOOLS } from '@apify/actors-mcp-server/internals/test-kit.js';

import {
    ACTOR_NORMAL_MODE,
    AUTO_INJECTED_TOOL_NAMES,
    DEFAULT_ACTOR_NAMES,
    expectToolNamesToContain,
    expectWidgetToolMeta,
    getToolNames,
    RETIRED_SELECTORS,
    servedDefaultTools,
    servedDefaultToolNames,
    skipUnlessStdio,
    withClient,
} from '../helpers.js';
import type { Case } from '../types.js';

const TWO_TEST_ACTORS = ['apify/python-example', 'apify/rag-web-browser'];
const SINGLE_NORMAL_MODE_ACTOR = [ACTOR_NORMAL_MODE];
const DOCS_CATEGORY = ['docs'] as ToolCategory[];
const DOCS_RUNS_STORAGE_CATEGORIES = ['docs', 'runs', 'storage'] as ToolCategory[];

/** Tool/Actor selection, categories, env loading, auto-inject, server mode. */
export const registrationCases: Case[] = [
    {
        // telemetry off so default tool set is deterministic across environments.
        name: 'should match spec default: actors,docs,apify/rag-web-browser when no params provided (telemetry off)',
        isDeploymentTest: true,
        run: withClient({ telemetry: { enabled: false } }, async (client) => {
            const tools = await client.listTools();
            const names = getToolNames(tools);

            // Equivalent to tools=actors,docs,apify/rag-web-browser (no widgets outside apps).
            const expectedActorsTools = ['fetch-actor-details', 'search-actors', 'call-actor'];
            const expectedDocsTools = ['search-apify-docs', 'fetch-apify-docs'];
            const expectedActors = [actorNameToToolName('apify/rag-web-browser')];

            const expectedTotal = expectedActorsTools.concat(expectedDocsTools, expectedActors);
            expect(names).toHaveLength(expectedTotal.length + AUTO_INJECTED_TOOL_NAMES.length);

            expectToolNamesToContain(names, expectedActorsTools);
            expectToolNamesToContain(names, expectedDocsTools);
            expect(names).not.toContain(HELPER_TOOLS.PROBLEM_REPORT);
            expectToolNamesToContain(names, expectedActors);
            expectToolNamesToContain(names, AUTO_INJECTED_TOOL_NAMES);
        }),
    },
    {
        // telemetry on — only difference is report-problem.
        name: 'should match spec default: actors,docs,apify/rag-web-browser when no params provided (telemetry on)',
        isDeploymentTest: true,
        run: withClient({ telemetry: { enabled: true } }, async (client) => {
            const tools = await client.listTools();
            const names = getToolNames(tools);

            const expectedActorsTools = ['fetch-actor-details', 'search-actors', 'call-actor'];
            const expectedDocsTools = ['search-apify-docs', 'fetch-apify-docs'];
            const expectedActors = [actorNameToToolName('apify/rag-web-browser')];
            const expectedFeedbackTools = [HELPER_TOOLS.PROBLEM_REPORT];

            const expectedTotal = expectedActorsTools.concat(expectedDocsTools, expectedActors, expectedFeedbackTools);
            expect(names).toHaveLength(expectedTotal.length + AUTO_INJECTED_TOOL_NAMES.length);

            expectToolNamesToContain(names, expectedActorsTools);
            expectToolNamesToContain(names, expectedDocsTools);
            expect(names).toContain(HELPER_TOOLS.PROBLEM_REPORT);
            expectToolNamesToContain(names, expectedActors);
            expectToolNamesToContain(names, AUTO_INJECTED_TOOL_NAMES);
        }),
    },
    {
        // isDeploymentTest: default tool/Actor set.
        name: 'should list all default tools and Actors',
        isDeploymentTest: true,
        run: withClient(undefined, async (client) => {
            const names = getToolNames(await client.listTools());
            expect(names.length).toEqual(servedDefaultTools().length + defaults.actors.length + 4);

            expectToolNamesToContain(names, servedDefaultToolNames());
            expectToolNamesToContain(names, DEFAULT_ACTOR_NAMES);
            expectToolNamesToContain(names, AUTO_INJECTED_TOOL_NAMES);
            // get-actor-run should be automatically included when call-actor is present
            expect(names).toContain(HELPER_TOOLS.ACTOR_RUNS_GET);
        }),
    },
    {
        name: 'loads no tools for retired selectors',
        isDeploymentTest: false,
        run: withClient({ tools: [...RETIRED_SELECTORS] }, async (client) => {
            const names = getToolNames(await client.listTools());
            expect(names).toHaveLength(0);
        }),
    },
    {
        name: 'should list two loaded Actors plus auto-injected storage and abort tools',
        isDeploymentTest: false,
        run: withClient({ actors: TWO_TEST_ACTORS, serverMode: 'default' }, async (client) => {
            const names = getToolNames(await client.listTools());
            // Actor tools trigger auto-injected helpers (get-actor-run, storage, abort).
            expect(names.length).toEqual(TWO_TEST_ACTORS.length + AUTO_INJECTED_TOOL_NAMES.length);
            expectToolNamesToContain(
                names,
                TWO_TEST_ACTORS.map((actor) => actorNameToToolName(actor)),
            );
            expectToolNamesToContain(names, AUTO_INJECTED_TOOL_NAMES);
        }),
    },
    {
        name: 'should load only specified actors when actors param is provided (no other tools)',
        isDeploymentTest: false,
        run: withClient({ actors: SINGLE_NORMAL_MODE_ACTOR, serverMode: 'default' }, async (client) => {
            const names = getToolNames(await client.listTools());

            // Should only load the specified actor plus auto-injected storage/abort helpers
            expect(names.length).toEqual(SINGLE_NORMAL_MODE_ACTOR.length + AUTO_INJECTED_TOOL_NAMES.length);
            expect(names).toContain(actorNameToToolName(SINGLE_NORMAL_MODE_ACTOR[0]));
            expectToolNamesToContain(names, AUTO_INJECTED_TOOL_NAMES);

            // Should NOT include any default category tools
            expect(names).not.toContain('search-actors');
            expect(names).not.toContain('fetch-actor-details');
            expect(names).not.toContain('call-actor');
            expect(names).not.toContain('search-apify-docs');
            expect(names).not.toContain('fetch-apify-docs');
        }),
    },
    {
        name: 'should return tool with execution field when listing tools with apify/normal-mode-test-actor',
        isDeploymentTest: false,
        run: withClient({ tools: SINGLE_NORMAL_MODE_ACTOR }, async (client) => {
            const tools = await client.listTools();

            // Find the tool for apify/normal-mode-test-actor
            const normalModeTool = tools.tools.find((tool) => tool.name === actorNameToToolName(ACTOR_NORMAL_MODE));
            expect(normalModeTool).toBeDefined();
            expect(normalModeTool).toHaveProperty('name');
            expect(normalModeTool).toHaveProperty('description');
            expect(normalModeTool).toHaveProperty('inputSchema');
        }),
    },
    {
        name: 'should not load any tools when tools param is empty',
        isDeploymentTest: false,
        run: withClient({ tools: [] }, async (client) => {
            const names = getToolNames(await client.listTools());
            expect(names).toHaveLength(0);
        }),
    },
    {
        name: 'should not load any tools when actors param is empty',
        isDeploymentTest: false,
        run: withClient({ actors: [] }, async (client) => {
            const names = getToolNames(await client.listTools());
            expect(names.length).toEqual(0);
        }),
    },
    {
        name: 'should not load any tools when both tools and actors params are empty',
        isDeploymentTest: false,
        run: withClient({ tools: [], actors: [] }, async (client) => {
            const names = getToolNames(await client.listTools());
            expect(names.length).toEqual(0);
        }),
    },
    {
        name: 'should load only specified Actors via tools selectors when actors param omitted',
        isDeploymentTest: false,
        run: withClient({ tools: SINGLE_NORMAL_MODE_ACTOR, serverMode: 'default' }, async (client) => {
            const names = getToolNames(await client.listTools());
            // The Actor plus auto-injected storage/abort helpers.
            expect(names).toHaveLength(SINGLE_NORMAL_MODE_ACTOR.length + AUTO_INJECTED_TOOL_NAMES.length);
            expect(names).toContain(actorNameToToolName(SINGLE_NORMAL_MODE_ACTOR[0]));
            expectToolNamesToContain(names, AUTO_INJECTED_TOOL_NAMES);
        }),
    },
    {
        name: 'should treat selectors with slashes as Actor names',
        isDeploymentTest: false,
        run: withClient({ tools: ['docs', ACTOR_NORMAL_MODE] }, async (client) => {
            const names = getToolNames(await client.listTools());

            // Should include docs category
            expect(names).toContain('search-apify-docs');
            expect(names).toContain('fetch-apify-docs');

            // Should include actor (if it exists/is valid)
            expect(names).toContain(actorNameToToolName(ACTOR_NORMAL_MODE));
        }),
    },
    {
        name: 'should merge actors param into tools selectors (backward compatibility)',
        isDeploymentTest: false,
        run: withClient({ tools: DOCS_CATEGORY, actors: SINGLE_NORMAL_MODE_ACTOR }, async (client) => {
            const names = getToolNames(await client.listTools());
            const docsToolNames = getExpectedToolNamesByCategories(DOCS_CATEGORY);
            const expected = [...docsToolNames, actorNameToToolName(SINGLE_NORMAL_MODE_ACTOR[0])];
            // Actor tool triggers auto-injection of storage/abort helpers.
            expect(names).toHaveLength(expected.length + AUTO_INJECTED_TOOL_NAMES.length);

            const containsExpected = expected.every((n) => names.includes(n));
            expect(containsExpected).toBe(true);
            expectToolNamesToContain(names, AUTO_INJECTED_TOOL_NAMES);
        }),
    },
    {
        // category + specific tools must not widen to whole sibling category.
        name: 'should handle mixed categories and specific tools in tools param',
        isDeploymentTest: true,
        run: withClient({ tools: ['docs', 'fetch-actor-details', 'call-actor'] }, async (client) => {
            const names = getToolNames(await client.listTools());

            expect(names).toContain('search-apify-docs'); // from docs category
            expect(names).toContain('fetch-apify-docs'); // from docs category
            expect(names).toContain('fetch-actor-details'); // specific tool
            expect(names).toContain('call-actor'); // specific tool

            // Should NOT include other actors-category tools
            expect(names).not.toContain('search-actors');
        }),
    },
    {
        name: 'loads docs while dropping retired selectors',
        isDeploymentTest: false,
        run: withClient({ tools: ['docs', ...RETIRED_SELECTORS] }, async (client) => {
            const names = getToolNames(await client.listTools());
            expect(names).toEqual([HELPER_TOOLS.DOCS_SEARCH, HELPER_TOOLS.DOCS_FETCH]);
        }),
    },
    {
        name: 'should load only docs tools',
        isDeploymentTest: false,
        run: withClient({ tools: DOCS_CATEGORY, actors: [] }, async (client) => {
            const names = getToolNames(await client.listTools());
            const expected = getExpectedToolNamesByCategories(DOCS_CATEGORY);
            expect(names.length).toEqual(expected.length);
            expectToolNamesToContain(names, expected);
        }),
    },
    {
        name: 'should load only a specific tool when tools includes a tool name',
        isDeploymentTest: false,
        run: withClient({ tools: ['fetch-actor-details'], actors: [] }, async (client) => {
            const names = getToolNames(await client.listTools());
            expect(names).toEqual(['fetch-actor-details']);
        }),
    },
    {
        name: 'should not load any tools when tools param is empty and actors omitted',
        isDeploymentTest: false,
        run: withClient({ tools: [] }, async (client) => {
            const names = getToolNames(await client.listTools());
            expect(names.length).toEqual(0);
        }),
    },
    {
        name: 'should not load any internal tools when tools param is empty and use custom Actor if specified',
        isDeploymentTest: false,
        run: withClient({ tools: [], actors: [ACTOR_NORMAL_MODE] }, async (client) => {
            const names = getToolNames(await client.listTools());
            // Actor tool triggers auto-injected helpers (get-actor-run, storage, abort).
            expect(names.length).toEqual(1 + AUTO_INJECTED_TOOL_NAMES.length);
            expect(names).toContain(actorNameToToolName(ACTOR_NORMAL_MODE));
            expectToolNamesToContain(names, AUTO_INJECTED_TOOL_NAMES);
        }),
    },
    // `dev` is telemetry-gated (unit-tested); skip standalone load here.
    ...Object.keys(getCategoryTools('default'))
        .filter((category) => category !== 'dev')
        .map(
            (category): Case => ({
                name: `should load correct tools for ${category} category`,
                isDeploymentTest: false,
                run: withClient({ tools: [category as ToolCategory] }, async (client) => {
                    const loadedTools = await client.listTools();
                    const toolNames = getToolNames(loadedTools);

                    const expectedToolNames = getExpectedToolNamesByCategories([category as ToolCategory]);
                    // Only assert that all tools from the selected category are present.
                    for (const expectedToolName of expectedToolNames) {
                        expect(toolNames).toContain(expectedToolName);
                    }
                }),
            }),
        ),
    {
        name: 'should handle multiple tool category keys input correctly',
        isDeploymentTest: false,
        run: withClient({ tools: DOCS_RUNS_STORAGE_CATEGORIES }, async (client) => {
            const loadedTools = await client.listTools();
            const toolNames = getToolNames(loadedTools);

            const expectedToolNames = getExpectedToolNamesByCategories(DOCS_RUNS_STORAGE_CATEGORIES);
            expect(toolNames).toHaveLength(expectedToolNames.length);
            const containsExpectedTools = toolNames.every((name) => expectedToolNames.includes(name));
            expect(containsExpectedTools).toBe(true);
        }),
    },
    {
        // Environment variable tests - only applicable to stdio transport
        name: 'should load actors from ACTORS environment variable',
        isDeploymentTest: false,
        skipIf: skipUnlessStdio,
        run: async (ctx) => {
            const actors = ['apify/python-example', 'apify/rag-web-browser'];
            const client = await ctx.createClientFn({ actors, useEnv: true });
            try {
                const names = getToolNames(await client.listTools());
                expectToolNamesToContain(
                    names,
                    actors.map((actor) => actorNameToToolName(actor)),
                );
            } finally {
                await client.close();
            }
        },
    },
    {
        name: 'should load tool categories from TOOLS environment variable',
        isDeploymentTest: false,
        skipIf: skipUnlessStdio,
        run: async (ctx) => {
            // TOOLS=docs via stdio; docs avoids auto-inject noise.
            const client = await ctx.createClientFn({ tools: ['docs'], useEnv: true });
            try {
                const toolNames = getToolNames(await client.listTools());
                expect(toolNames).toContain(HELPER_TOOLS.DOCS_SEARCH);
                expect(toolNames).toContain(HELPER_TOOLS.DOCS_FETCH);
                expect(toolNames).not.toContain(HELPER_TOOLS.ACTOR_CALL);
                expect(toolNames).not.toContain(HELPER_TOOLS.ACTOR_RUNS_GET);
            } finally {
                await client.close();
            }
        },
    },
    {
        name: 'should auto-inject storage and abort tools after call-actor in expected order',
        isDeploymentTest: false,
        run: withClient(undefined, async (client) => {
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
        }),
    },
    {
        name: 'should not auto-inject storage and abort tools when no actor-touching tools are present',
        isDeploymentTest: false,
        run: withClient({ tools: ['docs'] }, async (client) => {
            const names = getToolNames(await client.listTools());
            for (const name of AUTO_INJECTED_TOOL_NAMES) expect(names).not.toContain(name);
            expect(names).not.toContain(HELPER_TOOLS.ACTOR_RUNS_GET);
        }),
    },
    {
        // Environment variable precedence test
        name: 'should use TELEMETRY_ENABLED env var when CLI arg is not provided',
        isDeploymentTest: false,
        skipIf: skipUnlessStdio,
        run: async (ctx) => {
            // When useEnv=true, telemetry.enabled option translates to env.TELEMETRY_ENABLED in child process
            const client = await ctx.createClientFn({ useEnv: true, telemetry: { enabled: false } });
            try {
                const tools = await client.listTools();
                // Verify tools are loaded correctly
                expect(tools.tools.length).toBeGreaterThan(0);
            } finally {
                await client.close();
            }
        },
    },
    {
        // Deprecated `openai` alias silently normalizes to apps.
        name: 'should use UI_MODE env var (deprecated "openai" alias) when CLI arg is not provided',
        isDeploymentTest: false,
        skipIf: skipUnlessStdio,
        run: async (ctx) => {
            const client = await ctx.createClientFn({ useEnv: true, serverMode: 'openai' });
            try {
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
                await client.close();
            }
        },
    },
    {
        name: 'should enable apps mode when serverMode is apps',
        isDeploymentTest: false,
        run: withClient({ serverMode: 'apps' }, async (client) => {
            const tools = await client.listTools();
            const toolNames = getToolNames(tools);
            expect(tools.tools.length).toBeGreaterThan(0);

            expect(toolNames).toContain(HELPER_TOOLS.ACTOR_GET_DETAILS_WIDGET);
            expect(toolNames).toContain(HELPER_TOOLS.STORE_SEARCH_WIDGET);
            expect(toolNames).toContain(HELPER_TOOLS.ACTOR_CALL_WIDGET);

            // Verify that tools have widget metadata when UI mode is enabled via URL parameter
            expectWidgetToolMeta(tools);
        }),
    },
    {
        name: 'should treat serverMode=true the same as serverMode=apps',
        isDeploymentTest: false,
        run: withClient({ serverMode: 'true' }, async (client) => {
            const tools = await client.listTools();
            const toolNames = getToolNames(tools);
            expect(tools.tools.length).toBeGreaterThan(0);

            expect(toolNames).toContain(HELPER_TOOLS.ACTOR_GET_DETAILS_WIDGET);
            expect(toolNames).toContain(HELPER_TOOLS.STORE_SEARCH_WIDGET);
            expect(toolNames).toContain(HELPER_TOOLS.ACTOR_CALL_WIDGET);
            expectWidgetToolMeta(tools);
        }),
    },
    {
        name: 'should automatically include get-actor-run for default settings when call-actor is enabled',
        isDeploymentTest: false,
        run: withClient({ serverMode: 'apps' }, async (client) => {
            const tools = await client.listTools();
            const toolNames = getToolNames(tools);

            // When serverMode is enabled, default tools include call-actor, so get-actor-run should be included
            expect(toolNames).toContain(HELPER_TOOLS.ACTOR_CALL);
            expect(toolNames).toContain(HELPER_TOOLS.ACTOR_RUNS_GET);
        }),
    },
    {
        name: 'should not include get-actor-run when only docs tools are selected',
        isDeploymentTest: false,
        run: withClient({ serverMode: 'apps', tools: ['docs'] }, async (client) => {
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
        }),
    },
];
