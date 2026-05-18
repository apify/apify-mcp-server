/**
 * Tests for the tool call reason middleware.
 *
 * Covers:
 * - `injectReasonProperty`: shape, idempotency, required-list handling, no-op on bad input
 * - `extractAndStripReason`: extraction, mutation, trimming, type guards, length cap
 * - `getToolPublicFieldOnly` integration: every tool listed exposes `reason`
 */
import { describe, expect, it } from 'vitest';

import type { ToolBase, ToolInputSchema } from '../../src/types.js';
import {
    extractAndStripReason,
    injectReasonProperty,
    TOOL_CALL_REASON_DESCRIPTION,
    TOOL_CALL_REASON_MAX_LENGTH,
    TOOL_CALL_REASON_PROPERTY,
} from '../../src/utils/tool_call_reason.js';
import { getToolPublicFieldOnly } from '../../src/utils/tools.js';

describe('injectReasonProperty()', () => {
    it('adds reason to properties and required', () => {
        const result = injectReasonProperty({
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
        });

        const props = result.properties as Record<string, { type: string; description: string }>;
        expect(props[TOOL_CALL_REASON_PROPERTY]).toEqual({
            type: 'string',
            description: TOOL_CALL_REASON_DESCRIPTION,
        });
        expect(result.required).toEqual(['query', TOOL_CALL_REASON_PROPERTY]);
    });

    it('warns against leaking conversation context, PII, and secrets in the description', () => {
        expect(TOOL_CALL_REASON_DESCRIPTION).toMatch(/personal data|PII/i);
        expect(TOOL_CALL_REASON_DESCRIPTION).toMatch(/secret|password|token/i);
        expect(TOOL_CALL_REASON_DESCRIPTION).toMatch(/conversation|context/i);
    });

    it('initializes required when missing', () => {
        const result = injectReasonProperty({
            type: 'object',
            properties: { query: { type: 'string' } },
        });
        expect(result.required).toEqual([TOOL_CALL_REASON_PROPERTY]);
    });

    it('is idempotent — does not duplicate property or required entry', () => {
        const once = injectReasonProperty({
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
        });
        const twice = injectReasonProperty(once);

        expect(twice).toBe(once);
        expect(twice.required).toEqual(['query', TOOL_CALL_REASON_PROPERTY]);
    });

    it('does not mutate the input schema', () => {
        const original: ToolInputSchema = {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
        };
        const snapshot = JSON.stringify(original);
        injectReasonProperty(original);
        expect(JSON.stringify(original)).toBe(snapshot);
    });

    it('returns input unchanged when not an object', () => {
        const bad = null as unknown as ToolInputSchema;
        expect(injectReasonProperty(bad)).toBe(bad);
    });
});

describe('extractAndStripReason()', () => {
    it('returns the trimmed reason and removes it from args', () => {
        const args = { reason: '  fetch weather data  ', query: 'forecast' };
        const result = extractAndStripReason(args);
        expect(result).toBe('fetch weather data');
        expect(args).toEqual({ query: 'forecast' });
    });

    it('returns undefined and still strips the key when value is empty/whitespace', () => {
        const args: Record<string, unknown> = { reason: '   ', query: 'x' };
        expect(extractAndStripReason(args)).toBeUndefined();
        expect(args).toEqual({ query: 'x' });
    });

    it('returns undefined and strips the key when value is not a string', () => {
        const args: Record<string, unknown> = { reason: 42, query: 'x' };
        expect(extractAndStripReason(args)).toBeUndefined();
        expect(args).toEqual({ query: 'x' });
    });

    it('returns undefined when reason is absent (no-op)', () => {
        const args: Record<string, unknown> = { query: 'x' };
        expect(extractAndStripReason(args)).toBeUndefined();
        expect(args).toEqual({ query: 'x' });
    });

    it('returns undefined when args is undefined', () => {
        expect(extractAndStripReason(undefined)).toBeUndefined();
    });

    it('caps reason length at TOOL_CALL_REASON_MAX_LENGTH', () => {
        const long = 'x'.repeat(TOOL_CALL_REASON_MAX_LENGTH + 100);
        const args: Record<string, unknown> = { reason: long };
        const result = extractAndStripReason(args);
        expect(result).toHaveLength(TOOL_CALL_REASON_MAX_LENGTH);
    });
});

describe('getToolPublicFieldOnly() integration', () => {
    it('injects reason into a listed tool\'s input schema', () => {
        const tool = {
            name: 'some-tool',
            description: 'Test tool',
            inputSchema: {
                type: 'object',
                properties: { query: { type: 'string' } },
                required: ['query'],
            },
        } as unknown as ToolBase;

        const result = getToolPublicFieldOnly(tool, { filterWidgetMeta: false });
        const schema = result.inputSchema as {
            required?: string[];
            properties?: Record<string, { description?: string }>;
        };

        expect(schema.properties?.[TOOL_CALL_REASON_PROPERTY]?.description).toBe(TOOL_CALL_REASON_DESCRIPTION);
        expect(schema.required).toContain(TOOL_CALL_REASON_PROPERTY);
    });
});
