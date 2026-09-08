import { describe, expect, it } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { CATEGORY_NAMES, getCategoryTools, toolCategories } from '../../src/tools/index.js';
import type { ToolCategory, ToolEntry } from '../../src/types.js';

describe('CATEGORY_NAMES', () => {
    it('should match the keys of toolCategories', () => {
        const staticKeys = Object.keys(toolCategories);
        expect([...CATEGORY_NAMES]).toEqual(staticKeys);
    });
});

describe('getCategoryTools', () => {
    it('should return all category keys matching CATEGORY_NAMES', () => {
        const defaultResult = getCategoryTools('default');
        const appsResult = getCategoryTools('apps');

        for (const name of CATEGORY_NAMES) {
            expect(defaultResult).toHaveProperty(name);
            expect(appsResult).toHaveProperty(name);
        }
    });

    it('should return no undefined entries in any category (circular-init safety)', () => {
        const defaultResult = getCategoryTools('default');
        const appsResult = getCategoryTools('apps');

        for (const name of CATEGORY_NAMES) {
            for (const tool of defaultResult[name]) {
                expect(tool).toBeDefined();
                expect(tool.name).toBeDefined();
            }
            for (const tool of appsResult[name]) {
                expect(tool).toBeDefined();
                expect(tool.name).toBeDefined();
            }
        }
    });

    it('should share the same call-actor tool across modes (mode-independent object; widget addendum is session-gated)', () => {
        const defaultResult = getCategoryTools('default');
        const appsResult = getCategoryTools('apps');

        const defaultCallActor = defaultResult.actors.find((t: ToolEntry) => t.name === HELPER_TOOLS.ACTOR_CALL);
        const appsCallActor = appsResult.actors.find((t: ToolEntry) => t.name === HELPER_TOOLS.ACTOR_CALL);
        expect(defaultCallActor).toBeDefined();
        expect(appsCallActor).toBeDefined();
        expect(defaultCallActor).toBe(appsCallActor);
    });

    it('should share the same get-actor-run tool across modes (mode-independent)', () => {
        const defaultResult = getCategoryTools('default');
        const appsResult = getCategoryTools('apps');

        const defaultGetRun = defaultResult.runs.find((t: ToolEntry) => t.name === HELPER_TOOLS.ACTOR_RUNS_GET);
        const appsGetRun = appsResult.runs.find((t: ToolEntry) => t.name === HELPER_TOOLS.ACTOR_RUNS_GET);

        expect(defaultGetRun).toBeDefined();
        expect(appsGetRun).toBeDefined();
        // Same object — data-only, mode-independent. UI rendering lives in get-actor-run-widget.
        expect(defaultGetRun).toBe(appsGetRun);
    });

    it('should share identical tools for mode-independent categories', () => {
        const defaultResult = getCategoryTools('default');
        const appsResult = getCategoryTools('apps');

        const modeIndependentCategories: ToolCategory[] = ['docs', 'storage', 'tasks', 'dev'];
        for (const cat of modeIndependentCategories) {
            expect(defaultResult[cat]).toEqual(appsResult[cat]);
        }
    });

    it('should preserve tool ordering within categories', () => {
        const result = getCategoryTools('default');
        const actorNames = result.actors.map((t: ToolEntry) => t.name);

        // Verify workflow order: search → details → call
        expect(actorNames).toEqual([
            HELPER_TOOLS.STORE_SEARCH,
            HELPER_TOOLS.ACTOR_GET_DETAILS,
            HELPER_TOOLS.ACTOR_CALL,
        ]);
    });
});
