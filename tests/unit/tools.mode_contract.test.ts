/**
 * Contract tests for tool-mode separation.
 *
 * These tests verify the invariants that must hold across modes:
 * - Each mode produces the expected set of tools per category
 * - Mode-variant tools share identical inputSchema (same args accepted)
 * - Tool definitions are frozen (immutable)
 * - _meta stripping works for non-openai modes
 */
import { describe, expect, it } from 'vitest';

import { HelperTools } from '../../src/const.js';
import { CATEGORY_NAMES, getCategoryTools } from '../../src/tools/index.js';
import type { ToolEntry } from '../../src/types.js';
import { SERVER_MODES } from '../../src/types.js';
import { getToolPublicFieldOnly } from '../../src/utils/tools.js';

/** Helper to extract tool names from a category. */
function toolNames(tools: ToolEntry[]): string[] {
    return tools.map((t) => t.name);
}

describe('getCategoryTools mode contract (tool-mode separation)', () => {
    const defaultCategories = getCategoryTools('default');
    const openaiCategories = getCategoryTools('openai');

    describe('per-mode tool lists', () => {
        it('should have correct tools in experimental category (both modes)', () => {
            expect(toolNames(defaultCategories.experimental)).toEqual([HelperTools.ACTOR_ADD]);
            expect(toolNames(openaiCategories.experimental)).toEqual([HelperTools.ACTOR_ADD]);
        });

        it('should have correct tools in actors category (both modes)', () => {
            const expected = [HelperTools.STORE_SEARCH, HelperTools.ACTOR_GET_DETAILS, HelperTools.ACTOR_CALL];
            expect(toolNames(defaultCategories.actors)).toEqual(expected);
            expect(toolNames(openaiCategories.actors)).toEqual(expected);
        });

        it('should have empty ui category in default mode', () => {
            expect(toolNames(defaultCategories.ui)).toEqual([]);
        });

        it('should have internal tools in ui category in openai mode', () => {
            expect(toolNames(openaiCategories.ui)).toEqual([
                HelperTools.STORE_SEARCH_INTERNAL,
                HelperTools.ACTOR_GET_DETAILS_INTERNAL,
            ]);
        });

        it('should have correct tools in docs category (both modes)', () => {
            const expected = [HelperTools.DOCS_SEARCH, HelperTools.DOCS_FETCH];
            expect(toolNames(defaultCategories.docs)).toEqual(expected);
            expect(toolNames(openaiCategories.docs)).toEqual(expected);
        });

        it('should have correct tools in runs category (both modes)', () => {
            const expected = [
                HelperTools.ACTOR_RUNS_GET,
                HelperTools.ACTOR_RUN_LIST_GET,
                HelperTools.ACTOR_RUNS_LOG,
                HelperTools.ACTOR_RUNS_ABORT,
            ];
            expect(toolNames(defaultCategories.runs)).toEqual(expected);
            expect(toolNames(openaiCategories.runs)).toEqual(expected);
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
            expect(toolNames(openaiCategories.storage)).toEqual(expected);
        });

        it('should have correct tools in dev category (both modes)', () => {
            expect(toolNames(defaultCategories.dev)).toEqual([HelperTools.GET_HTML_SKELETON]);
            expect(toolNames(openaiCategories.dev)).toEqual([HelperTools.GET_HTML_SKELETON]);
        });
    });

    describe('tool name invariance across modes', () => {
        // Tool names MUST be identical across all modes for every category that has tools in both modes.
        // This invariant is relied upon by getExpectedToolNamesByCategories, getUnauthEnabledToolCategories,
        // and isApiTokenRequired — which all hardcode 'default' mode internally.
        for (const categoryName of CATEGORY_NAMES) {
            const defaultNames = toolNames(defaultCategories[categoryName]);
            const openaiNames = toolNames(openaiCategories[categoryName]);

            // Only check categories that exist in both modes (ui category is openai-only)
            if (defaultNames.length > 0 && openaiNames.length > 0) {
                it(`should have identical tool names in ${categoryName} category across modes`, () => {
                    expect(defaultNames).toEqual(openaiNames);
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
                const openaiTool = [...openaiCategories.actors, ...openaiCategories.runs]
                    .find((t) => t.name === name);

                expect(defaultTool).toBeDefined();
                expect(openaiTool).toBeDefined();
                expect(defaultTool!.inputSchema).toEqual(openaiTool!.inputSchema);
            });
        }
    });

    describe('mode-specific call-actor behavior guidance', () => {
        it('should document that openai call-actor always runs asynchronously', () => {
            const openaiCallActor = openaiCategories.actors.find((t) => t.name === HelperTools.ACTOR_CALL);

            expect(openaiCallActor).toBeDefined();
            expect(openaiCallActor!.description).toContain('always runs asynchronously');
            expect(openaiCallActor!.description).toContain('do NOT poll or call any other tool');
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

    it('should strip openai/ and ui _meta keys when filterOpenAiMeta is true and not in openai mode', () => {
        const result = getToolPublicFieldOnly(toolWithOpenAiMeta, {
            filterOpenAiMeta: true,
            mode: 'default',
        });
        expect(result._meta).toBeDefined();
        expect(result._meta).toEqual({ 'regular-key': { data: 123 } });
        expect(result._meta).not.toHaveProperty('openai/widget');
        expect(result._meta).not.toHaveProperty('openai/config');
        expect(result._meta).not.toHaveProperty('ui');
    });

    it('should preserve all _meta keys in openai mode', () => {
        const result = getToolPublicFieldOnly(toolWithOpenAiMeta, {
            filterOpenAiMeta: true,
            mode: 'openai',
        });
        expect(result._meta).toEqual(toolWithOpenAiMeta._meta);
    });

    it('should preserve all _meta keys when filterOpenAiMeta is false', () => {
        const result = getToolPublicFieldOnly(toolWithOpenAiMeta, {
            filterOpenAiMeta: false,
        });
        expect(result._meta).toEqual(toolWithOpenAiMeta._meta);
    });

    it('should return undefined _meta when all keys are widget-specific and mode is not openai', () => {
        const toolWithOnlyWidgetMeta = {
            ...toolWithOpenAiMeta,
            _meta: {
                'openai/widget': { type: 'test' },
                ui: { resourceUri: 'ui://widget/test.html' },
            },
        };
        const result = getToolPublicFieldOnly(toolWithOnlyWidgetMeta, {
            filterOpenAiMeta: true,
            mode: 'default',
        });
        expect(result._meta).toBeUndefined();
    });
});
