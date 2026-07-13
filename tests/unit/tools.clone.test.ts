/**
 * Tests for `cloneToolEntry`.
 *
 * Covers:
 * - Deep copy with independent data
 * - Preserves functions (ajvValidate, call)
 * - Actor tools, internal tools
 */
import { describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import type { ActorTool, HelperTool } from '../../src/types.js';
import { TOOL_TYPE } from '../../src/types.js';
import { respondRaw } from '../../src/utils/mcp.js';
import { cloneToolEntry } from '../../src/utils/tools.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const MOCK_AJV_VALIDATE = vi.fn(() => true);

function makeInternalTool(overrides: Partial<HelperTool> = {}): HelperTool {
    return {
        name: HELPER_TOOLS.ACTOR_CALL,
        description: 'Call an Actor',
        type: TOOL_TYPE.INTERNAL,
        inputSchema: {
            type: 'object' as const,
            properties: { actor: { type: 'string' } },
        },
        ajvValidate: MOCK_AJV_VALIDATE as never,
        call: vi.fn(async () => respondRaw({ content: [] })),
        ...overrides,
    };
}

function makeActorTool(overrides: Partial<ActorTool> = {}): ActorTool {
    return {
        name: 'apify--web-scraper',
        description: 'Web scraper tool',
        type: TOOL_TYPE.ACTOR,
        actorId: 'abc123',
        actorFullName: 'apify/web-scraper',
        inputSchema: {
            type: 'object' as const,
            properties: { url: { type: 'string' } },
        },
        ajvValidate: MOCK_AJV_VALIDATE as never,
        ...overrides,
    };
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
