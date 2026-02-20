import { describe, expect, it } from 'vitest';

import { HelperTools } from '../../src/const.js';
import { buildCategories, CATEGORY_NAMES, toolCategories } from '../../src/tools/index.js';
import type { ToolCategory, ToolEntry } from '../../src/types.js';

describe('CATEGORY_NAMES', () => {
    it('should match the keys of the static toolCategories', () => {
        const staticKeys = Object.keys(toolCategories).sort();
        const categoryNames = [...CATEGORY_NAMES].sort();
        expect(categoryNames).toEqual(staticKeys);
    });
});

describe('buildCategories', () => {
    it('should return all category keys matching CATEGORY_NAMES', () => {
        const defaultResult = buildCategories();
        const openaiResult = buildCategories('openai');

        for (const name of CATEGORY_NAMES) {
            expect(defaultResult).toHaveProperty(name);
            expect(openaiResult).toHaveProperty(name);
        }
    });

    it('should return no undefined entries in any category (circular-init safety)', () => {
        const defaultResult = buildCategories();
        const openaiResult = buildCategories('openai');

        for (const name of CATEGORY_NAMES) {
            for (const tool of defaultResult[name]) {
                expect(tool).toBeDefined();
                expect(tool.name).toBeDefined();
            }
            for (const tool of openaiResult[name]) {
                expect(tool).toBeDefined();
                expect(tool.name).toBeDefined();
            }
        }
    });

    it('should return empty ui category in default mode', () => {
        const result = buildCategories();
        expect(result.ui).toEqual([]);
    });

    it('should return non-empty ui category in openai mode', () => {
        const result = buildCategories('openai');
        expect(result.ui.length).toBeGreaterThan(0);
    });

    it('should return different tool variants for actors category based on mode', () => {
        const defaultResult = buildCategories();
        const openaiResult = buildCategories('openai');

        // Both modes should have the same tool names in actors category
        const defaultNames = defaultResult.actors.map((t: ToolEntry) => t.name);
        const openaiNames = openaiResult.actors.map((t: ToolEntry) => t.name);
        expect(defaultNames).toEqual(openaiNames);

        // But the actual tool objects should be different (different call implementations)
        expect(defaultResult.actors[0]).not.toBe(openaiResult.actors[0]);
    });

    it('should return different get-actor-run variants based on mode', () => {
        const defaultResult = buildCategories();
        const openaiResult = buildCategories('openai');

        const defaultGetRun = defaultResult.runs.find((t: ToolEntry) => t.name === HelperTools.ACTOR_RUNS_GET);
        const openaiGetRun = openaiResult.runs.find((t: ToolEntry) => t.name === HelperTools.ACTOR_RUNS_GET);

        expect(defaultGetRun).toBeDefined();
        expect(openaiGetRun).toBeDefined();
        // Different objects (different implementations)
        expect(defaultGetRun).not.toBe(openaiGetRun);
    });

    it('should share identical tools for mode-independent categories', () => {
        const defaultResult = buildCategories();
        const openaiResult = buildCategories('openai');

        const modeIndependentCategories: ToolCategory[] = ['experimental', 'docs', 'storage', 'dev'];
        for (const cat of modeIndependentCategories) {
            expect(defaultResult[cat]).toEqual(openaiResult[cat]);
        }
    });

    it('should preserve tool ordering within categories', () => {
        const result = buildCategories();
        const actorNames = result.actors.map((t: ToolEntry) => t.name);

        // Verify workflow order: search → details → call
        expect(actorNames).toEqual([
            HelperTools.STORE_SEARCH,
            HelperTools.ACTOR_GET_DETAILS,
            HelperTools.ACTOR_CALL,
        ]);
    });
});
