/**
 * Tests for Skyfire augmentation logic: `applySkyfireAugmentation` and `cloneToolEntry`.
 *
 * Covers:
 * - Eligible vs non-eligible tools
 * - Idempotency (double-apply does not duplicate)
 * - Frozen originals are not mutated
 * - `cloneToolEntry` preserves functions (ajvValidate, call)
 * - Actor tools, internal tools, and actor-mcp tools
 */
import { describe, expect, it, vi } from 'vitest';

import {
    HelperTools,
    SKYFIRE_ENABLED_TOOLS,
    SKYFIRE_PAY_ID_PROPERTY_DESCRIPTION,
    SKYFIRE_TOOL_INSTRUCTIONS,
} from '../../src/const.js';
import type { ActorMcpTool, ActorTool, HelperTool, ToolEntry } from '../../src/types.js';
import { applySkyfireAugmentation, cloneToolEntry } from '../../src/utils/tools.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const MOCK_AJV_VALIDATE = vi.fn(() => true);

function makeInternalTool(overrides: Partial<HelperTool> = {}): HelperTool {
    return {
        name: HelperTools.ACTOR_CALL,
        description: 'Call an Actor',
        type: 'internal',
        inputSchema: {
            type: 'object' as const,
            properties: { actor: { type: 'string' } },
        },
        ajvValidate: MOCK_AJV_VALIDATE as never,
        call: vi.fn(async () => ({ content: [] })),
        ...overrides,
    };
}

function makeActorTool(overrides: Partial<ActorTool> = {}): ActorTool {
    return {
        name: 'apify--web-scraper',
        description: 'Web scraper tool',
        type: 'actor',
        actorFullName: 'apify/web-scraper',
        inputSchema: {
            type: 'object' as const,
            properties: { url: { type: 'string' } },
        },
        ajvValidate: MOCK_AJV_VALIDATE as never,
        ...overrides,
    };
}

function makeActorMcpTool(overrides: Partial<ActorMcpTool> = {}): ActorMcpTool {
    return {
        name: 'some-mcp-tool',
        description: 'A proxied MCP tool',
        type: 'actor-mcp',
        originToolName: 'some-tool',
        actorId: 'apify/some-actor',
        serverId: 'server-123',
        serverUrl: 'https://example.com/mcp',
        inputSchema: {
            type: 'object' as const,
            properties: { input: { type: 'string' } },
        },
        ajvValidate: MOCK_AJV_VALIDATE as never,
        ...overrides,
    };
}

function makeNonEligibleInternalTool(): HelperTool {
    // search-apify-docs is NOT in SKYFIRE_ENABLED_TOOLS
    return makeInternalTool({
        name: HelperTools.DOCS_SEARCH,
        description: 'Search documentation',
    });
}

// ---------------------------------------------------------------------------
// cloneToolEntry
// ---------------------------------------------------------------------------

describe('cloneToolEntry', () => {
    it('should create a deep copy with independent data', () => {
        const original = makeInternalTool();
        const cloned = cloneToolEntry(original);

        // Different objects
        expect(cloned).not.toBe(original);
        expect(cloned.inputSchema).not.toBe(original.inputSchema);

        // Same data
        expect(cloned.name).toBe(original.name);
        expect(cloned.description).toBe(original.description);
        expect(cloned.type).toBe(original.type);
        expect(cloned.inputSchema).toEqual(original.inputSchema);
    });

    it('should preserve ajvValidate function reference', () => {
        const original = makeInternalTool();
        const cloned = cloneToolEntry(original);

        expect(cloned.ajvValidate).toBe(original.ajvValidate);
        expect(typeof cloned.ajvValidate).toBe('function');
    });

    it('should preserve call function reference for internal tools', () => {
        const original = makeInternalTool();
        const cloned = cloneToolEntry(original) as HelperTool;

        expect(cloned.call).toBe(original.call);
        expect(typeof cloned.call).toBe('function');
    });

    it('should work for actor tools (no call function)', () => {
        const original = makeActorTool();
        const cloned = cloneToolEntry(original);

        expect(cloned.ajvValidate).toBe(original.ajvValidate);
        expect(cloned.name).toBe(original.name);
        expect((cloned as ActorTool).actorFullName).toBe(original.actorFullName);
    });

    it('should not share nested objects with the original', () => {
        const original = makeInternalTool();
        const cloned = cloneToolEntry(original);

        // Mutate clone's inputSchema
        (cloned.inputSchema.properties as Record<string, unknown>).newProp = { type: 'number' };

        // Original should be unaffected
        expect((original.inputSchema.properties as Record<string, unknown>).newProp).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// applySkyfireAugmentation — eligible tools
// ---------------------------------------------------------------------------

describe('applySkyfireAugmentation', () => {
    describe('eligible internal tools', () => {
        it('should augment an eligible internal tool', () => {
            const original = makeInternalTool({ name: HelperTools.ACTOR_CALL });
            const result = applySkyfireAugmentation(original);

            // Returns a different object (cloned)
            expect(result).not.toBe(original);
            expect(result.description).toContain(SKYFIRE_TOOL_INSTRUCTIONS);

            const props = result.inputSchema.properties as Record<string, unknown>;
            expect(props['skyfire-pay-id']).toEqual({
                type: 'string',
                description: SKYFIRE_PAY_ID_PROPERTY_DESCRIPTION,
            });
        });

        // Test each SKYFIRE_ENABLED_TOOLS member
        for (const toolName of SKYFIRE_ENABLED_TOOLS) {
            it(`should augment ${toolName}`, () => {
                const tool = makeInternalTool({ name: toolName });
                const result = applySkyfireAugmentation(tool);

                expect(result).not.toBe(tool);
                expect(result.description).toContain(SKYFIRE_TOOL_INSTRUCTIONS);
            });
        }
    });

    describe('actor tools', () => {
        it('should augment any actor tool (type: actor)', () => {
            const original = makeActorTool();
            const result = applySkyfireAugmentation(original);

            expect(result).not.toBe(original);
            expect(result.description).toContain(SKYFIRE_TOOL_INSTRUCTIONS);

            const props = result.inputSchema.properties as Record<string, unknown>;
            expect(props['skyfire-pay-id']).toBeDefined();
        });
    });

    describe('non-eligible tools', () => {
        it('should return the original reference for non-eligible internal tool', () => {
            const original = makeNonEligibleInternalTool();
            const result = applySkyfireAugmentation(original);

            // Returns the exact same object (not cloned)
            expect(result).toBe(original);
            expect(result.description).not.toContain(SKYFIRE_TOOL_INSTRUCTIONS);
        });

        it('should return the original reference for actor-mcp tool', () => {
            const original = makeActorMcpTool();
            const result = applySkyfireAugmentation(original);

            expect(result).toBe(original);
            expect(result.description).not.toContain(SKYFIRE_TOOL_INSTRUCTIONS);
        });
    });

    describe('idempotency', () => {
        it('should not double-append description when called twice', () => {
            const original = makeInternalTool({ name: HelperTools.ACTOR_CALL });
            const firstPass = applySkyfireAugmentation(original);
            const secondPass = applySkyfireAugmentation(firstPass);

            // Description should contain SKYFIRE_TOOL_INSTRUCTIONS exactly once
            const occurrences = secondPass.description!.split(SKYFIRE_TOOL_INSTRUCTIONS).length - 1;
            expect(occurrences).toBe(1);
        });

        it('should not duplicate skyfire-pay-id property when called twice', () => {
            const original = makeActorTool();
            const firstPass = applySkyfireAugmentation(original);
            const secondPass = applySkyfireAugmentation(firstPass);

            const props = secondPass.inputSchema.properties as Record<string, unknown>;
            expect(props['skyfire-pay-id']).toEqual({
                type: 'string',
                description: SKYFIRE_PAY_ID_PROPERTY_DESCRIPTION,
            });
        });
    });

    describe('frozen originals', () => {
        it('should not mutate a frozen internal tool', () => {
            const original = Object.freeze(makeInternalTool({ name: HelperTools.ACTOR_CALL }));
            const result = applySkyfireAugmentation(original);

            // Result is augmented
            expect(result.description).toContain(SKYFIRE_TOOL_INSTRUCTIONS);

            // Original is unchanged
            expect(original.description).not.toContain(SKYFIRE_TOOL_INSTRUCTIONS);
            expect(Object.isFrozen(original)).toBe(true);
        });

        it('should not mutate a frozen actor tool', () => {
            const original = Object.freeze(makeActorTool());
            const result = applySkyfireAugmentation(original);

            expect(result.description).toContain(SKYFIRE_TOOL_INSTRUCTIONS);
            expect(original.description).not.toContain(SKYFIRE_TOOL_INSTRUCTIONS);
        });

        it('should return frozen non-eligible tool as-is', () => {
            const original = Object.freeze(makeNonEligibleInternalTool());
            const result = applySkyfireAugmentation(original);

            expect(result).toBe(original);
            expect(Object.isFrozen(result)).toBe(true);
        });
    });

    describe('function preservation', () => {
        it('should preserve ajvValidate on augmented internal tool', () => {
            const original = makeInternalTool({ name: HelperTools.ACTOR_CALL });
            const result = applySkyfireAugmentation(original) as HelperTool;

            expect(result.ajvValidate).toBe(original.ajvValidate);
            expect(typeof result.ajvValidate).toBe('function');
        });

        it('should preserve call function on augmented internal tool', () => {
            const original = makeInternalTool({ name: HelperTools.ACTOR_CALL });
            const result = applySkyfireAugmentation(original) as HelperTool;

            expect(result.call).toBe(original.call);
            expect(typeof result.call).toBe('function');
        });

        it('should preserve ajvValidate on augmented actor tool', () => {
            const original = makeActorTool();
            const result = applySkyfireAugmentation(original);

            expect(result.ajvValidate).toBe(original.ajvValidate);
        });
    });

    describe('edge cases', () => {
        it('should handle tool with no description gracefully', () => {
            const original = makeInternalTool({
                name: HelperTools.ACTOR_CALL,
                description: undefined as unknown as string,
            });
            const result = applySkyfireAugmentation(original);

            // Should not throw, description stays undefined
            expect(result.description).toBeUndefined();
        });

        it('should handle tool with empty inputSchema properties', () => {
            const original = makeInternalTool({
                name: HelperTools.ACTOR_CALL,
                inputSchema: { type: 'object' as const, properties: {} },
            });
            const result = applySkyfireAugmentation(original);

            const props = result.inputSchema.properties as Record<string, unknown>;
            expect(props['skyfire-pay-id']).toBeDefined();
        });
    });
});

// ---------------------------------------------------------------------------
// Matrix: mode × eligibility (using buildCategories tools)
// ---------------------------------------------------------------------------

describe('Skyfire eligibility matrix', () => {
    const testCases: { tool: ToolEntry; eligible: boolean; label: string }[] = [
        { tool: makeInternalTool({ name: HelperTools.ACTOR_CALL }), eligible: true, label: 'internal/eligible (call-actor)' },
        { tool: makeInternalTool({ name: HelperTools.ACTOR_OUTPUT_GET }), eligible: true, label: 'internal/eligible (get-actor-output)' },
        { tool: makeNonEligibleInternalTool(), eligible: false, label: 'internal/non-eligible (search-apify-docs)' },
        { tool: makeActorTool(), eligible: true, label: 'actor tool' },
        { tool: makeActorMcpTool(), eligible: false, label: 'actor-mcp tool' },
    ];

    for (const { tool, eligible, label } of testCases) {
        it(`${label}: eligible=${eligible}`, () => {
            const result = applySkyfireAugmentation(tool);

            if (eligible) {
                expect(result).not.toBe(tool);
                expect(result.description).toContain(SKYFIRE_TOOL_INSTRUCTIONS);
                const props = result.inputSchema.properties as Record<string, unknown>;
                expect(props['skyfire-pay-id']).toBeDefined();
            } else {
                expect(result).toBe(tool);
                expect(result.description).not.toContain(SKYFIRE_TOOL_INSTRUCTIONS);
            }
        });
    }
});
