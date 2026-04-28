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

import { ALLOWED_TASK_TOOL_EXECUTION_MODES, HelperTools } from '../../src/const.js';
import { WIDGET_BY_BASE_TOOL } from '../../src/tools/categories.js';
import { searchApifyDocsTool } from '../../src/tools/common/search_apify_docs.js';
import { searchActorsBaseArgsSchema } from '../../src/tools/core/search_actors_common.js';
import { CATEGORY_NAMES, getCategoryTools } from '../../src/tools/index.js';
import type { Input, ToolBase, ToolEntry } from '../../src/types.js';
import { SERVER_MODES, ServerMode } from '../../src/types.js';
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
        it('should have correct tools in experimental category (both modes)', () => {
            expect(toolNames(defaultCategories.experimental)).toEqual([HelperTools.ACTOR_ADD]);
            expect(toolNames(appsCategories.experimental)).toEqual([HelperTools.ACTOR_ADD]);
        });

        it('should have correct tools in actors category (both modes)', () => {
            const expected = [HelperTools.STORE_SEARCH, HelperTools.ACTOR_GET_DETAILS, HelperTools.ACTOR_CALL];
            expect(toolNames(defaultCategories.actors)).toEqual(expected);
            expect(toolNames(appsCategories.actors)).toEqual(expected);
        });

        it('should have correct tools in docs category (both modes)', () => {
            const expected = [HelperTools.DOCS_SEARCH, HelperTools.DOCS_FETCH];
            expect(toolNames(defaultCategories.docs)).toEqual(expected);
            expect(toolNames(appsCategories.docs)).toEqual(expected);
        });

        it('should have correct tools in runs category (both modes)', () => {
            const expected = [
                HelperTools.ACTOR_RUNS_GET,
                HelperTools.ACTOR_RUN_LIST_GET,
                HelperTools.ACTOR_RUNS_LOG,
                HelperTools.ACTOR_RUNS_ABORT,
            ];
            expect(toolNames(defaultCategories.runs)).toEqual(expected);
            expect(toolNames(appsCategories.runs)).toEqual(expected);
        });

        it('should have correct tools in storage category (both modes)', () => {
            const expected = [
                HelperTools.DATASET_GET,
                HelperTools.DATASET_GET_ITEMS,
                HelperTools.DATASET_SCHEMA_GET,
                HelperTools.ACTOR_OUTPUT_GET,
                HelperTools.KEY_VALUE_STORE_GET,
                HelperTools.KEY_VALUE_STORE_KEYS_GET,
                HelperTools.KEY_VALUE_STORE_RECORD_GET,
                HelperTools.DATASET_LIST_GET,
                HelperTools.KEY_VALUE_STORE_LIST_GET,
            ];
            expect(toolNames(defaultCategories.storage)).toEqual(expected);
            expect(toolNames(appsCategories.storage)).toEqual(expected);
        });

        it('should have correct tools in dev category (both modes)', () => {
            expect(toolNames(defaultCategories.dev)).toEqual([]);
            expect(toolNames(appsCategories.dev)).toEqual([]);
        });
    });

    describe('tool name invariance across modes', () => {
        // Tool names MUST be identical across all modes for every category that has tools in both modes.
        // This invariant is relied upon by getExpectedToolNamesByCategories, getUnauthEnabledToolCategories,
        // and isApiTokenRequired — which all hardcode 'default' mode internally.
        for (const categoryName of CATEGORY_NAMES) {
            const defaultNames = toolNames(defaultCategories[categoryName]);
            const appsNames = toolNames(appsCategories[categoryName]);

            // Only check categories that exist in both modes
            if (defaultNames.length > 0 && appsNames.length > 0) {
                it(`should have identical tool names in ${categoryName} category across modes`, () => {
                    expect(defaultNames).toEqual(appsNames);
                });
            }
        }
    });

    describe('base data tools have no widget meta in either mode', () => {
        const baseTools: { name: HelperTools; category: keyof typeof defaultCategories }[] = [
            { name: HelperTools.ACTOR_GET_DETAILS, category: 'actors' },
            { name: HelperTools.STORE_SEARCH, category: 'actors' },
            { name: HelperTools.ACTOR_CALL, category: 'actors' },
            { name: HelperTools.ACTOR_RUNS_GET, category: 'runs' },
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
            HelperTools.STORE_SEARCH,
            HelperTools.ACTOR_GET_DETAILS,
            HelperTools.ACTOR_CALL,
            HelperTools.ACTOR_RUNS_GET,
        ];

        for (const name of modeVariantToolNames) {
            it(`should have identical inputSchema for ${name} across modes`, () => {
                const defaultTool = [...defaultCategories.actors, ...defaultCategories.runs]
                    .find((t) => t.name === name);
                const appsTool = [...appsCategories.actors, ...appsCategories.runs]
                    .find((t) => t.name === name);

                expect(defaultTool).toBeDefined();
                expect(appsTool).toBeDefined();
                expect(defaultTool!.inputSchema).toEqual(appsTool!.inputSchema);
            });
        }

        // Locks the invariant that search-actors-widget reuses the shared base schema
        // verbatim (see #700). Prevents silent drift on limit/offset/keywords.
        it('should use searchActorsBaseArgsSchema.strict() for search-actors-widget inputSchema', () => {
            const widgetTool = WIDGET_BY_BASE_TOOL.get(HelperTools.STORE_SEARCH);
            expect(widgetTool).toBeDefined();
            expect(widgetTool!.name).toBe(HelperTools.STORE_SEARCH_WIDGET);
            expect(widgetTool!.inputSchema).toEqual(z.toJSONSchema(searchActorsBaseArgsSchema.strict()));
        });
    });

    describe('mode-specific call-actor behavior guidance', () => {
        it('should document that apps call-actor always runs asynchronously and points to the widget sibling for UI', () => {
            const appsCallActor = appsCategories.actors.find((t) => t.name === HelperTools.ACTOR_CALL);

            expect(appsCallActor).toBeDefined();
            expect(appsCallActor!.description).toContain('always runs asynchronously');
            expect(appsCallActor!.description).toContain(HelperTools.ACTOR_CALL_WIDGET);
            expect(appsCallActor!.description).toContain('It renders no UI');
        });

        it('should not advertise long-running task support for apps call-actor', () => {
            const appsCallActor = appsCategories.actors.find((t) => t.name === HelperTools.ACTOR_CALL);

            expect(appsCallActor).toBeDefined();
            expect(appsCallActor!.execution?.taskSupport).toBeUndefined();
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

    describe('all tool names match HelperTools enum values', () => {
        const allHelperToolNames = new Set(Object.values(HelperTools));

        for (const mode of SERVER_MODES) {
            const categories = getCategoryTools(mode);

            for (const categoryName of CATEGORY_NAMES) {
                for (const tool of categories[categoryName]) {
                    it(`${tool.name} (${mode} mode) should be a known HelperTools value`, () => {
                        expect(allHelperToolNames.has(tool.name as HelperTools)).toBe(true);
                    });
                }
            }
        }

        for (const widget of WIDGET_BY_BASE_TOOL.values()) {
            it(`${widget.name} widget should be a known HelperTools value`, () => {
                expect(allHelperToolNames.has(widget.name as HelperTools)).toBe(true);
            });
        }
    });
});

describe('apps-mode widget pairing in getToolsForServerMode', () => {
    function namesFor(input: Input, mode: ServerMode): string[] {
        return getToolsForServerMode(input, [], mode).map((t) => t.name);
    }

    it('tools: ["docs"] in apps mode includes no widget tools', () => {
        const names = namesFor({ tools: ['docs'] }, ServerMode.APPS);
        expect(names).toContain(HelperTools.DOCS_SEARCH);
        expect(names).toContain(HelperTools.DOCS_FETCH);
        expect(names).not.toContain(HelperTools.STORE_SEARCH_WIDGET);
        expect(names).not.toContain(HelperTools.ACTOR_GET_DETAILS_WIDGET);
        expect(names).not.toContain(HelperTools.ACTOR_CALL_WIDGET);
        expect(names).not.toContain(HelperTools.ACTOR_RUNS_GET_WIDGET);
    });

    it('tools: ["search-actors"] in apps mode pairs only the search-actors widget', () => {
        const names = namesFor({ tools: ['search-actors'] }, ServerMode.APPS);
        expect(names).toContain(HelperTools.STORE_SEARCH);
        expect(names).toContain(HelperTools.STORE_SEARCH_WIDGET);
        expect(names).not.toContain(HelperTools.ACTOR_GET_DETAILS_WIDGET);
        expect(names).not.toContain(HelperTools.ACTOR_CALL_WIDGET);
    });

    it('tools: ["call-actor"] in apps mode pairs call-actor-widget and the auto-injected get-actor-run-widget', () => {
        const names = namesFor({ tools: ['call-actor'] }, ServerMode.APPS);
        expect(names).toContain(HelperTools.ACTOR_CALL);
        expect(names).toContain(HelperTools.ACTOR_CALL_WIDGET);
        expect(names).toContain(HelperTools.ACTOR_RUNS_GET);
        expect(names).toContain(HelperTools.ACTOR_RUNS_GET_WIDGET);
        expect(names).toContain(HelperTools.ACTOR_OUTPUT_GET);
        expect(names).not.toContain(HelperTools.STORE_SEARCH_WIDGET);
        expect(names).not.toContain(HelperTools.ACTOR_GET_DETAILS_WIDGET);
    });

    it('tools: ["actors"] category in apps mode pairs all four actor widgets', () => {
        const names = namesFor({ tools: ['actors'] }, ServerMode.APPS);
        expect(names).toContain(HelperTools.STORE_SEARCH_WIDGET);
        expect(names).toContain(HelperTools.ACTOR_GET_DETAILS_WIDGET);
        expect(names).toContain(HelperTools.ACTOR_CALL_WIDGET);
        expect(names).toContain(HelperTools.ACTOR_RUNS_GET_WIDGET);
    });

    it('default mode adds no widget tools regardless of selection', () => {
        const names = namesFor({ tools: ['actors'] }, ServerMode.DEFAULT);
        expect(names).not.toContain(HelperTools.STORE_SEARCH_WIDGET);
        expect(names).not.toContain(HelperTools.ACTOR_GET_DETAILS_WIDGET);
        expect(names).not.toContain(HelperTools.ACTOR_CALL_WIDGET);
        expect(names).not.toContain(HelperTools.ACTOR_RUNS_GET_WIDGET);
    });
});

describe('taskSupport contract across tool categories', () => {
    it('should declare taskSupport only on call-actor in default mode, with an allowed value', () => {
        const defaultCategories = getCategoryTools('default');
        const toolsWithTaskSupport: { name: string; value: unknown }[] = [];

        for (const categoryName of CATEGORY_NAMES) {
            for (const tool of defaultCategories[categoryName]) {
                if (tool.execution?.taskSupport !== undefined) {
                    toolsWithTaskSupport.push({ name: tool.name, value: tool.execution.taskSupport });
                }
            }
        }

        // Only default-mode call-actor is expected to declare taskSupport among static internal tools.
        // (Dynamically-created Actor tools from actor_tools_factory also declare it, but those are not
        // returned by getCategoryTools.)
        expect(toolsWithTaskSupport.map((t) => t.name)).toEqual([HelperTools.ACTOR_CALL]);

        for (const { value } of toolsWithTaskSupport) {
            expect(ALLOWED_TASK_TOOL_EXECUTION_MODES).toContain(value);
        }
    });

    it('should not declare taskSupport on any tool in apps mode', () => {
        const appsCategories = getCategoryTools('apps');

        for (const categoryName of CATEGORY_NAMES) {
            for (const tool of appsCategories[categoryName]) {
                expect(tool.execution?.taskSupport).toBeUndefined();
            }
        }
    });
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
        const { inputSchema } = getToolPublicFieldOnly(searchApifyDocsTool, { filterWidgetMeta: false });
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

    // Regression: #637 — phantom `default: undefined` from filterSchemaProperties must not clear required.
    it('should preserve required fields even when upstream writes `default: undefined`', () => {
        const toolWithPhantomDefaults = {
            name: 'apify--some-actor',
            description: 'Test Actor tool',
            inputSchema: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Search query', default: undefined },
                    maxResults: { type: 'integer', description: 'Limit', default: 3 },
                },
                required: ['query'],
            },
        } as unknown as ToolBase;

        const { inputSchema } = getToolPublicFieldOnly(toolWithPhantomDefaults, { filterWidgetMeta: false });
        const schema = inputSchema as { required?: string[] };

        expect(schema.required).toEqual(['query']);
    });
});
