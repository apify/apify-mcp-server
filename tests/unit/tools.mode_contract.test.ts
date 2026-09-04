/**
 * Contract tests for tool-mode separation.
 *
 * These tests verify the invariants that must hold across modes:
 * - Each mode produces the expected set of tools per category
 * - Mode-variant tools share identical inputSchema (same args accepted)
 * - Tool definitions are frozen (immutable)
 * - _meta stripping works for non-apps modes
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ALLOWED_TASK_TOOL_EXECUTION_MODES, HELPER_TOOLS, type HelperToolName } from '../../src/const.js';
import { fetchActorDetails } from '../../src/tools/actors/fetch_actor_details.js';
import { searchActorsBaseArgsSchema } from '../../src/tools/actors/search_actors.js';
import { searchApifyDocs } from '../../src/tools/docs/search_apify_docs.js';
import { CATEGORY_NAMES, getCategoryTools } from '../../src/tools/index.js';
import { WIDGET_BY_BASE_TOOL } from '../../src/tools/registry.js';
import type { Input, ToolBase, ToolEntry } from '../../src/types.js';
import { SERVER_MODES, SERVER_MODE } from '../../src/types.js';
import { getToolPublicFieldOnly } from '../../src/utils/tools.js';
import { getToolsForServerMode } from '../../src/utils/tools_loader.js';

/** Helper to extract tool names from a category. */
function toolNames(tools: ToolEntry[]): string[] {
    return tools.map((t) => t.name);
}

describe('getCategoryTools mode contract (tool-mode separation)', () => {
    const defaultCategories = getCategoryTools('default');
    const appsCategories = getCategoryTools('apps');

    describe('per-mode tool lists', () => {
        it('should have correct tools in actors category (both modes)', () => {
            const expected = [HELPER_TOOLS.STORE_SEARCH, HELPER_TOOLS.ACTOR_GET_DETAILS, HELPER_TOOLS.ACTOR_CALL];
            expect(toolNames(defaultCategories.actors)).toEqual(expected);
            expect(toolNames(appsCategories.actors)).toEqual(expected);
        });

        it('should have correct tools in docs category (both modes)', () => {
            const expected = [HELPER_TOOLS.DOCS_SEARCH, HELPER_TOOLS.DOCS_FETCH];
            expect(toolNames(defaultCategories.docs)).toEqual(expected);
            expect(toolNames(appsCategories.docs)).toEqual(expected);
        });

        it('should have correct tools in runs category (both modes)', () => {
            const expected = [
                HELPER_TOOLS.ACTOR_RUNS_GET,
                HELPER_TOOLS.ACTOR_RUN_LIST_GET,
                HELPER_TOOLS.ACTOR_RUNS_LOG,
                HELPER_TOOLS.ACTOR_RUNS_ABORT,
            ];
            expect(toolNames(defaultCategories.runs)).toEqual(expected);
            expect(toolNames(appsCategories.runs)).toEqual(expected);
        });

        it('should have correct tools in storage category (both modes)', () => {
            const expected = [
                HELPER_TOOLS.DATASET_GET,
                HELPER_TOOLS.DATASET_GET_ITEMS,
                HELPER_TOOLS.DATASET_SCHEMA_GET,
                HELPER_TOOLS.KEY_VALUE_STORE_GET,
                HELPER_TOOLS.KEY_VALUE_STORE_KEYS_GET,
                HELPER_TOOLS.KEY_VALUE_STORE_RECORD_GET,
                HELPER_TOOLS.DATASET_LIST_GET,
                HELPER_TOOLS.KEY_VALUE_STORE_LIST_GET,
            ];
            expect(toolNames(defaultCategories.storage)).toEqual(expected);
            expect(toolNames(appsCategories.storage)).toEqual(expected);
        });

        it('should have correct tools in tasks category (both modes)', () => {
            const expected = [
                HELPER_TOOLS.ACTOR_TASK_CREATE,
                HELPER_TOOLS.ACTOR_TASK_GET,
                HELPER_TOOLS.ACTOR_TASK_UPDATE,
                HELPER_TOOLS.ACTOR_TASK_PUBLISH,
                HELPER_TOOLS.ACTOR_TASK_UNPUBLISH,
            ];
            expect(toolNames(defaultCategories.tasks)).toEqual(expected);
            expect(toolNames(appsCategories.tasks)).toEqual(expected);
        });

        it('should have correct tools in deploy category (both modes)', () => {
            const expected = [HELPER_TOOLS.ACTOR_BUILD_GET, HELPER_TOOLS.ACTOR_BUILD];
            expect(toolNames(defaultCategories.deploy)).toEqual(expected);
            expect(toolNames(appsCategories.deploy)).toEqual(expected);
        });

        it('should have correct tools in dev category (both modes)', () => {
            const expected = [HELPER_TOOLS.PROBLEM_REPORT];
            expect(toolNames(defaultCategories.dev)).toEqual(expected);
            expect(toolNames(appsCategories.dev)).toEqual(expected);
        });
    });

    describe('tool name invariance across modes', () => {
        // Tool names MUST be identical across all modes for every category that has tools in both modes.
        // This invariant is relied upon by getExpectedToolNamesByCategories, getUnauthEnabledToolCategories,
        // and isApiTokenRequired — which all hardcode 'default' mode internally.
        for (const categoryName of CATEGORY_NAMES) {
            const defaultNames = toolNames(defaultCategories[categoryName]);
            const appsNames = toolNames(appsCategories[categoryName]);
            const bothModesHaveCategory = defaultNames.length > 0 && appsNames.length > 0;

            it.runIf(bothModesHaveCategory)(
                `should have identical tool names in ${categoryName} category across modes`,
                () => {
                    expect(defaultNames).toEqual(appsNames);
                },
            );
        }
    });

    describe('base data tools have no widget meta in either mode', () => {
        const baseTools: { name: HelperToolName; category: keyof typeof defaultCategories }[] = [
            { name: HELPER_TOOLS.ACTOR_GET_DETAILS, category: 'actors' },
            { name: HELPER_TOOLS.STORE_SEARCH, category: 'actors' },
            { name: HELPER_TOOLS.ACTOR_CALL, category: 'actors' },
            { name: HELPER_TOOLS.ACTOR_RUNS_GET, category: 'runs' },
        ];
        for (const mode of SERVER_MODES) {
            for (const { name, category } of baseTools) {
                it(`${name} should have no ui/openai _meta keys in ${mode} mode`, () => {
                    const categories = getCategoryTools(mode);
                    const base = categories[category].find((t) => t.name === name);
                    expect(base).toBeDefined();
                    const meta = base!._meta ?? {};
                    for (const key of Object.keys(meta)) {
                        expect(key).not.toMatch(/^openai\//);
                        expect(key).not.toBe('ui');
                    }
                });
            }
        }
    });

    describe('inputSchema parity for mode-variant tools', () => {
        const modeVariantToolNames = [
            HELPER_TOOLS.STORE_SEARCH,
            HELPER_TOOLS.ACTOR_GET_DETAILS,
            HELPER_TOOLS.ACTOR_CALL,
            HELPER_TOOLS.ACTOR_RUNS_GET,
        ];

        for (const name of modeVariantToolNames) {
            it(`should have identical inputSchema for ${name} across modes`, () => {
                const defaultTool = [...defaultCategories.actors, ...defaultCategories.runs].find(
                    (t) => t.name === name,
                );
                const appsTool = [...appsCategories.actors, ...appsCategories.runs].find((t) => t.name === name);

                expect(defaultTool).toBeDefined();
                expect(appsTool).toBeDefined();
                expect(defaultTool!.inputSchema).toEqual(appsTool!.inputSchema);
            });
        }

        // Locks the invariant that search-actors-widget reuses the shared base schema
        // verbatim (see #700). Prevents silent drift on limit/offset/keywords.
        it('should use searchActorsBaseArgsSchema.strict() for search-actors-widget inputSchema', () => {
            const widgetTool = WIDGET_BY_BASE_TOOL.get(HELPER_TOOLS.STORE_SEARCH);
            expect(widgetTool).toBeDefined();
            expect(widgetTool!.name).toBe(HELPER_TOOLS.STORE_SEARCH_WIDGET);
            expect(widgetTool!.inputSchema).toEqual(z.toJSONSchema(searchActorsBaseArgsSchema.strict()));
        });
    });

    describe('mode-specific call-actor behavior guidance', () => {
        it('apps call-actor description points to the widget sibling and warns against search-actors-widget for name resolution', () => {
            const appsCallActor = appsCategories.actors.find((t) => t.name === HELPER_TOOLS.ACTOR_CALL);
            const defaultCallActor = defaultCategories.actors.find((t) => t.name === HELPER_TOOLS.ACTOR_CALL);

            expect(appsCallActor).toBeDefined();
            expect(appsCallActor!.description).toContain(HELPER_TOOLS.ACTOR_CALL_WIDGET);
            expect(appsCallActor!.description).toContain(HELPER_TOOLS.STORE_SEARCH_WIDGET);

            // Widget guidance must not leak into default mode where those tools don't exist.
            expect(defaultCallActor).toBeDefined();
            expect(defaultCallActor!.description).not.toContain(HELPER_TOOLS.ACTOR_CALL_WIDGET);
            expect(defaultCallActor!.description).not.toContain(HELPER_TOOLS.STORE_SEARCH_WIDGET);
        });
    });

    describe('fetch-actor-details name-resolution guidance', () => {
        it('sends the model to search-actors for an inexact name when that tool is served', () => {
            const { description } = getToolPublicFieldOnly(fetchActorDetails, {
                presentTools: new Set([HELPER_TOOLS.ACTOR_GET_DETAILS, HELPER_TOOLS.STORE_SEARCH]),
            });

            expect(description).toContain('Requires the exact ID or full name');
            expect(description).toContain(`find it with ${HELPER_TOOLS.STORE_SEARCH} first`);
        });

        // The half of the guidance that names no tool must survive a session without
        // search-actors — it is the only instruction there against inventing a name.
        it('keeps the exact-name requirement when search-actors is absent', () => {
            const { description } = getToolPublicFieldOnly(fetchActorDetails, {
                presentTools: new Set([HELPER_TOOLS.ACTOR_GET_DETAILS]),
            });

            expect(description).toContain('do not construct a plausible-looking name');
            expect(description).not.toContain(HELPER_TOOLS.STORE_SEARCH);
        });
    });

    describe('tool definitions are frozen', () => {
        for (const mode of SERVER_MODES) {
            const categories = getCategoryTools(mode);

            for (const categoryName of CATEGORY_NAMES) {
                for (const tool of categories[categoryName]) {
                    it(`${tool.name} (${mode} mode) should be frozen`, () => {
                        expect(Object.isFrozen(tool)).toBe(true);
                    });
                }
            }
        }

        for (const widget of WIDGET_BY_BASE_TOOL.values()) {
            it(`${widget.name} widget should be frozen`, () => {
                expect(Object.isFrozen(widget)).toBe(true);
            });
        }
    });

    describe('all tool names match HELPER_TOOLS values', () => {
        const allHelperToolNames = new Set(Object.values(HELPER_TOOLS));

        for (const mode of SERVER_MODES) {
            const categories = getCategoryTools(mode);

            for (const categoryName of CATEGORY_NAMES) {
                for (const tool of categories[categoryName]) {
                    it(`${tool.name} (${mode} mode) should be a known HELPER_TOOLS value`, () => {
                        expect(allHelperToolNames.has(tool.name as HelperToolName)).toBe(true);
                    });
                }
            }
        }

        for (const widget of WIDGET_BY_BASE_TOOL.values()) {
            it(`${widget.name} widget should be a known HELPER_TOOLS value`, () => {
                expect(allHelperToolNames.has(widget.name as HelperToolName)).toBe(true);
            });
        }
    });
});

describe('apps-mode widget pairing in getToolsForServerMode', () => {
    function namesFor(input: Input, mode: SERVER_MODE): string[] {
        return getToolsForServerMode(input, [], mode).map((t) => t.name);
    }

    it('tools: ["docs"] in apps mode includes no widget tools', () => {
        const names = namesFor({ tools: ['docs'] }, SERVER_MODE.APPS);
        expect(names).toContain(HELPER_TOOLS.DOCS_SEARCH);
        expect(names).toContain(HELPER_TOOLS.DOCS_FETCH);
        expect(names).not.toContain(HELPER_TOOLS.STORE_SEARCH_WIDGET);
        expect(names).not.toContain(HELPER_TOOLS.ACTOR_GET_DETAILS_WIDGET);
        expect(names).not.toContain(HELPER_TOOLS.ACTOR_CALL_WIDGET);
        expect(names).not.toContain(HELPER_TOOLS.ACTOR_RUNS_GET_WIDGET);
    });

    it('tools: ["search-actors"] in apps mode pairs only the search-actors widget', () => {
        const names = namesFor({ tools: ['search-actors'] }, SERVER_MODE.APPS);
        expect(names).toContain(HELPER_TOOLS.STORE_SEARCH);
        expect(names).toContain(HELPER_TOOLS.STORE_SEARCH_WIDGET);
        expect(names).not.toContain(HELPER_TOOLS.ACTOR_GET_DETAILS_WIDGET);
        expect(names).not.toContain(HELPER_TOOLS.ACTOR_CALL_WIDGET);
    });

    it('tools: ["call-actor"] in apps mode pairs call-actor-widget and the auto-injected get-actor-run-widget', () => {
        const names = namesFor({ tools: ['call-actor'] }, SERVER_MODE.APPS);
        expect(names).toContain(HELPER_TOOLS.ACTOR_CALL);
        expect(names).toContain(HELPER_TOOLS.ACTOR_CALL_WIDGET);
        expect(names).toContain(HELPER_TOOLS.ACTOR_RUNS_GET);
        expect(names).toContain(HELPER_TOOLS.ACTOR_RUNS_GET_WIDGET);
        expect(names).not.toContain(HELPER_TOOLS.STORE_SEARCH_WIDGET);
        expect(names).not.toContain(HELPER_TOOLS.ACTOR_GET_DETAILS_WIDGET);
    });

    it('tools: ["actors"] category in apps mode pairs all four actor widgets', () => {
        const names = namesFor({ tools: ['actors'] }, SERVER_MODE.APPS);
        expect(names).toContain(HELPER_TOOLS.STORE_SEARCH_WIDGET);
        expect(names).toContain(HELPER_TOOLS.ACTOR_GET_DETAILS_WIDGET);
        expect(names).toContain(HELPER_TOOLS.ACTOR_CALL_WIDGET);
        expect(names).toContain(HELPER_TOOLS.ACTOR_RUNS_GET_WIDGET);
    });

    it('default mode adds no widget tools regardless of selection', () => {
        const names = namesFor({ tools: ['actors'] }, SERVER_MODE.DEFAULT);
        expect(names).not.toContain(HELPER_TOOLS.STORE_SEARCH_WIDGET);
        expect(names).not.toContain(HELPER_TOOLS.ACTOR_GET_DETAILS_WIDGET);
        expect(names).not.toContain(HELPER_TOOLS.ACTOR_CALL_WIDGET);
        expect(names).not.toContain(HELPER_TOOLS.ACTOR_RUNS_GET_WIDGET);
    });
});

describe('taskSupport contract across tool categories', () => {
    for (const mode of SERVER_MODES) {
        it(`declares taskSupport only on call-actor in ${mode} mode, with an allowed value`, () => {
            const categories = getCategoryTools(mode);
            const toolsWithTaskSupport: { name: string; value: unknown }[] = [];

            for (const categoryName of CATEGORY_NAMES) {
                for (const tool of categories[categoryName]) {
                    if (tool.execution?.taskSupport !== undefined) {
                        toolsWithTaskSupport.push({ name: tool.name, value: tool.execution.taskSupport });
                    }
                }
            }

            // Only call-actor is expected to declare taskSupport among static internal tools.
            // (Dynamically-created Actor tools from actor_tools_factory also declare it, but those
            // are not returned by getCategoryTools.)
            expect(toolsWithTaskSupport.map((t) => t.name)).toEqual([HELPER_TOOLS.ACTOR_CALL]);

            for (const { value } of toolsWithTaskSupport) {
                expect(ALLOWED_TASK_TOOL_EXECUTION_MODES).toContain(value);
            }
        });
    }

    // Widgets render their own progress UI; they MUST NOT participate in the MCP task lifecycle,
    // otherwise a `request.params.task` call would be accepted and would duplicate the widget's
    // live-progress channel.
    for (const widget of WIDGET_BY_BASE_TOOL.values()) {
        it(`${widget.name} widget must not declare taskSupport`, () => {
            expect(widget.execution?.taskSupport).toBeUndefined();
        });
    }
});

describe('getToolPublicFieldOnly _meta filtering', () => {
    const toolWithOpenAiMeta = {
        name: 'test-tool',
        description: 'Test',
        inputSchema: { type: 'object' as const, properties: {} },
        ajvValidate: (() => true) as never,
        _meta: {
            'openai/widget': { type: 'test' },
            'openai/config': { key: 'value' },
            ui: { resourceUri: 'ui://widget/test.html' },
            'regular-key': { data: 123 },
        },
    };

    it('should strip openai/ and ui _meta keys when filterWidgetMeta is true and not in apps mode', () => {
        const result = getToolPublicFieldOnly(toolWithOpenAiMeta, {
            filterWidgetMeta: true,
            mode: 'default',
        });
        expect(result._meta).toBeDefined();
        expect(result._meta).toEqual({ 'regular-key': { data: 123 } });
        expect(result._meta).not.toHaveProperty('openai/widget');
        expect(result._meta).not.toHaveProperty('openai/config');
        expect(result._meta).not.toHaveProperty('ui');
    });

    it('should preserve all _meta keys in apps mode', () => {
        const result = getToolPublicFieldOnly(toolWithOpenAiMeta, {
            filterWidgetMeta: true,
            mode: 'apps',
        });
        expect(result._meta).toEqual(toolWithOpenAiMeta._meta);
    });

    it('should preserve all _meta keys when filterWidgetMeta is false', () => {
        const result = getToolPublicFieldOnly(toolWithOpenAiMeta, {
            filterWidgetMeta: false,
        });
        expect(result._meta).toEqual(toolWithOpenAiMeta._meta);
    });

    it('should return undefined _meta when all keys are widget-specific and mode is not apps', () => {
        const toolWithOnlyWidgetMeta = {
            ...toolWithOpenAiMeta,
            _meta: {
                'openai/widget': { type: 'test' },
                ui: { resourceUri: 'ui://widget/test.html' },
            },
        };
        const result = getToolPublicFieldOnly(toolWithOnlyWidgetMeta, {
            filterWidgetMeta: true,
            mode: 'default',
        });
        expect(result._meta).toBeUndefined();
    });
});

describe('getToolPublicFieldOnly inputSchema normalization', () => {
    it('should not expose Zod-defaulted fields as JSON Schema required (search-apify-docs)', () => {
        const { inputSchema } = getToolPublicFieldOnly(searchApifyDocs, { filterWidgetMeta: false });
        const schema = inputSchema as { required?: string[]; properties?: Record<string, { default?: unknown }> };

        expect(schema.required).toEqual(['query']);
        expect(schema.properties?.docSource).toMatchObject({ default: 'apify' });
        expect(schema.properties?.limit).toMatchObject({ default: 5 });
        expect(schema.properties?.offset).toMatchObject({ default: 0 });
    });

    // Regression: #637 — Actor required fields were dropped from tools/list output.
    it('should preserve required fields from Apify Actor-shape inputSchemas', () => {
        const actorShapeTool = {
            name: 'apify--some-actor',
            description: 'Test Actor tool',
            inputSchema: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Search query' },
                    maxResults: { type: 'integer', description: 'Limit', default: 3 },
                },
                required: ['query'],
            },
        } as unknown as ToolBase;

        const { inputSchema } = getToolPublicFieldOnly(actorShapeTool, { filterWidgetMeta: false });
        const schema = inputSchema as { required?: string[] };

        expect(schema.required).toEqual(['query']);
    });
});

/**
 * A description must not name a tool that is absent from the same session — the model would call
 * something `tools/list` never returned. Cross-tool references are gated per session via
 * `buildDescription` + `ctx.hasTool(...)` and rendered at the tools/list boundary
 * (`getToolPublicFieldOnly` with `presentTools`). This renders every session shape the same way
 * the list handlers do and checks the result.
 */
describe('tool descriptions never name a tool absent from the session', () => {
    /** Minimal direct Actor tool — enough to trigger AUTO_INJECTED_TOOLS and stand in for a real one. */
    const actorToolStub = {
        type: 'actor',
        name: 'apify--rag-web-browser',
        actorId: 'test-actor-id',
        actorFullName: 'apify/rag-web-browser',
        description: `Fetch output rows with ${HELPER_TOOLS.DATASET_GET_ITEMS}.`,
        inputSchema: { type: 'object', properties: {} },
    } as unknown as ToolEntry;
    const ALL_TOOL_NAMES: string[] = [...Object.values(HELPER_TOOLS), actorToolStub.name];

    const sessions: { label: string; input: Input; actorTools: ToolEntry[] }[] = [
        { label: 'default (no selectors)', input: {}, actorTools: [actorToolStub] },
        { label: "tools: ['docs']", input: { tools: ['docs'] }, actorTools: [] },
        { label: "tools: ['runs']", input: { tools: ['runs'] }, actorTools: [] },
        { label: "tools: ['storage']", input: { tools: ['storage'] }, actorTools: [] },
        { label: "tools: ['actors']", input: { tools: ['actors'] }, actorTools: [] },
        ...ALL_TOOL_NAMES.map((name) => ({
            label: `tools: ['${name}']`,
            input: { tools: [name] },
            actorTools: [],
        })),
        {
            label: 'Actor tool only',
            input: { tools: ['apify/rag-web-browser'] },
            actorTools: [actorToolStub],
        },
        // Mixed cross-category selectors — arbitrary combinations must render correctly too.
        {
            label: "tools: ['call-actor', 'get-dataset']",
            input: { tools: [HELPER_TOOLS.ACTOR_CALL, HELPER_TOOLS.DATASET_GET] },
            actorTools: [],
        },
        {
            label: "tools: ['search-actors', 'fetch-apify-docs']",
            input: { tools: [HELPER_TOOLS.STORE_SEARCH, HELPER_TOOLS.DOCS_FETCH] },
            actorTools: [],
        },
        {
            label: "tools: ['docs', 'get-key-value-store-keys']",
            input: { tools: ['docs', HELPER_TOOLS.KEY_VALUE_STORE_KEYS_GET] },
            actorTools: [],
        },
    ];

    for (const mode of SERVER_MODES) {
        for (const { label, input, actorTools } of sessions) {
            it(`${label} in ${mode} mode`, () => {
                const tools = getToolsForServerMode(input, actorTools, mode);
                const present = new Set(tools.map((t) => t.name));
                const absent = ALL_TOOL_NAMES.filter((name) => !present.has(name));

                const violations: string[] = [];
                for (const tool of tools) {
                    const { description } = getToolPublicFieldOnly(tool, { presentTools: present });
                    for (const line of (description ?? '').split('\n')) {
                        if (line.includes('available in this session')) {
                            violations.push(`${tool.name} still hedges instead of rendering: ${line.trim()}`);
                        }
                        for (const name of absent) {
                            // Boundary guard so `get-dataset` does not match inside `get-dataset-items`,
                            // nor `call-actor` inside `call-actor-widget`. `:` is excluded too — it
                            // marks a remote MCP-Actor tool ("apify/actors-mcp-server:fetch-apify-docs"),
                            // not a tool served from this session.
                            if (new RegExp(`(?<![\\w-:])${name}(?![\\w-])`).test(line)) {
                                violations.push(`${tool.name} names absent ${name}: ${line.trim()}`);
                            }
                        }
                    }
                }

                expect(violations).toEqual([]);
            });
        }
    }
});
