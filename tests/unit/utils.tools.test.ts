import type { ValidateFunction } from 'ajv';
import { describe, expect, it } from 'vitest';

import { HelperTools } from '../../src/const.js';
import type { ActorTool, HelperTool, ToolEntry } from '../../src/types.js';
import { sortToolsForListing } from '../../src/utils/tools.js';

// Mock ajvValidate function for test tools
const mockAjvValidate = (() => true) as unknown as ValidateFunction;

/**
 * Helper to create a mock internal tool for testing
 */
function createMockInternalTool(name: string): HelperTool {
    return {
        type: 'internal',
        name,
        description: `Test tool ${name}`,
        inputSchema: { type: 'object' as const, properties: {} },
        ajvValidate: mockAjvValidate,
        call: async () => ({}),
    };
}

/**
 * Helper to create a mock actor tool for testing
 */
function createMockActorTool(name: string): ActorTool {
    return {
        type: 'actor',
        name,
        description: `Actor tool ${name}`,
        inputSchema: { type: 'object' as const, properties: {} },
        ajvValidate: mockAjvValidate,
        actorFullName: `test/${name}`,
    };
}

describe('sortToolsForListing', () => {
    it('returns empty array for empty input', () => {
        const result = sortToolsForListing([]);
        expect(result).toEqual([]);
    });

    it('does not modify the original array', () => {
        const original: ToolEntry[] = [
            createMockInternalTool(HelperTools.DOCS_FETCH),
            createMockInternalTool(HelperTools.STORE_SEARCH),
        ];
        const originalCopy = [...original];
        sortToolsForListing(original);
        expect(original).toEqual(originalCopy);
    });

    it('sorts search tools before fetch tools', () => {
        const tools: ToolEntry[] = [
            createMockInternalTool(HelperTools.DOCS_FETCH),
            createMockInternalTool(HelperTools.STORE_SEARCH),
            createMockInternalTool(HelperTools.DOCS_SEARCH),
        ];
        const sorted = sortToolsForListing(tools);
        const names = sorted.map((t) => t.name);
        expect(names).toEqual([
            HelperTools.STORE_SEARCH,   // search-actors (discovery)
            HelperTools.DOCS_SEARCH,    // search-apify-docs (discovery)
            HelperTools.DOCS_FETCH,     // fetch-apify-docs (documentation)
        ]);
    });

    it('sorts internal tools in workflow order', () => {
        const tools: ToolEntry[] = [
            createMockInternalTool(HelperTools.ACTOR_OUTPUT_GET),
            createMockInternalTool(HelperTools.ACTOR_CALL),
            createMockInternalTool(HelperTools.ACTOR_GET_DETAILS),
            createMockInternalTool(HelperTools.STORE_SEARCH),
            createMockInternalTool(HelperTools.ACTOR_RUNS_GET),
        ];
        const sorted = sortToolsForListing(tools);
        const names = sorted.map((t) => t.name);
        expect(names).toEqual([
            HelperTools.STORE_SEARCH,       // 1. search-actors (discovery)
            HelperTools.ACTOR_GET_DETAILS,  // 2. fetch-actor-details (details)
            HelperTools.ACTOR_CALL,         // 3. call-actor (execution)
            HelperTools.ACTOR_RUNS_GET,     // 4. get-actor-run (monitoring)
            HelperTools.ACTOR_OUTPUT_GET,   // 5. get-actor-output (output)
        ]);
    });

    it('places actor tools after internal tools', () => {
        const tools: ToolEntry[] = [
            createMockActorTool('web-scraper'),
            createMockInternalTool(HelperTools.STORE_SEARCH),
            createMockActorTool('google-search'),
            createMockInternalTool(HelperTools.ACTOR_CALL),
        ];
        const sorted = sortToolsForListing(tools);
        const names = sorted.map((t) => t.name);
        // Internal tools should come first, then actor tools
        expect(names.indexOf(HelperTools.STORE_SEARCH)).toBeLessThan(names.indexOf('web-scraper'));
        expect(names.indexOf(HelperTools.ACTOR_CALL)).toBeLessThan(names.indexOf('google-search'));
    });

    it('sorts actor tools alphabetically within their group', () => {
        const tools: ToolEntry[] = [
            createMockActorTool('web-scraper'),
            createMockActorTool('amazon-scraper'),
            createMockActorTool('google-search'),
        ];
        const sorted = sortToolsForListing(tools);
        const names = sorted.map((t) => t.name);
        expect(names).toEqual(['amazon-scraper', 'google-search', 'web-scraper']);
    });

    it('places UI-only internal tools at the end of internal tools', () => {
        const tools: ToolEntry[] = [
            createMockInternalTool(HelperTools.STORE_SEARCH_INTERNAL),
            createMockInternalTool(HelperTools.STORE_SEARCH),
            createMockInternalTool(HelperTools.ACTOR_GET_DETAILS_INTERNAL),
        ];
        const sorted = sortToolsForListing(tools);
        const names = sorted.map((t) => t.name);
        expect(names).toEqual([
            HelperTools.STORE_SEARCH,
            HelperTools.STORE_SEARCH_INTERNAL,
            HelperTools.ACTOR_GET_DETAILS_INTERNAL,
        ]);
    });

    it('handles unknown internal tools by placing them after known tools but before actors', () => {
        const tools: ToolEntry[] = [
            createMockActorTool('scraper'),
            createMockInternalTool('unknown-tool'),
            createMockInternalTool(HelperTools.STORE_SEARCH),
        ];
        const sorted = sortToolsForListing(tools);
        const names = sorted.map((t) => t.name);

        // Order should be: known internal -> unknown internal -> actor
        expect(names.indexOf(HelperTools.STORE_SEARCH)).toBeLessThan(names.indexOf('unknown-tool'));
        expect(names.indexOf('unknown-tool')).toBeLessThan(names.indexOf('scraper'));
    });

    it('sorts storage tools in correct order', () => {
        const tools: ToolEntry[] = [
            createMockInternalTool(HelperTools.KEY_VALUE_STORE_RECORD_GET),
            createMockInternalTool(HelperTools.DATASET_GET),
            createMockInternalTool(HelperTools.KEY_VALUE_STORE_GET),
            createMockInternalTool(HelperTools.DATASET_GET_ITEMS),
        ];
        const sorted = sortToolsForListing(tools);
        const names = sorted.map((t) => t.name);
        expect(names).toEqual([
            HelperTools.DATASET_GET,
            HelperTools.DATASET_GET_ITEMS,
            HelperTools.KEY_VALUE_STORE_GET,
            HelperTools.KEY_VALUE_STORE_RECORD_GET,
        ]);
    });

    it('correctly sorts a full typical tool set', () => {
        const tools: ToolEntry[] = [
            createMockActorTool('rag-web-browser'),
            createMockInternalTool(HelperTools.DOCS_FETCH),
            createMockInternalTool(HelperTools.ACTOR_OUTPUT_GET),
            createMockInternalTool(HelperTools.STORE_SEARCH),
            createMockInternalTool(HelperTools.ACTOR_CALL),
            createMockInternalTool(HelperTools.ACTOR_RUNS_GET),
            createMockInternalTool(HelperTools.DOCS_SEARCH),
            createMockInternalTool(HelperTools.ACTOR_GET_DETAILS),
        ];

        const sorted = sortToolsForListing(tools);
        const names = sorted.map((t) => t.name);

        expect(names).toEqual([
            HelperTools.STORE_SEARCH,       // 1. search-actors
            HelperTools.DOCS_SEARCH,        // 2. search-apify-docs
            HelperTools.ACTOR_GET_DETAILS,  // 3. fetch-actor-details
            HelperTools.ACTOR_CALL,         // 4. call-actor
            HelperTools.ACTOR_RUNS_GET,     // 5. get-actor-run
            HelperTools.ACTOR_OUTPUT_GET,   // 6. get-actor-output
            HelperTools.DOCS_FETCH,         // 7. fetch-apify-docs
            'rag-web-browser',              // 8. actor tool
        ]);
    });
});
