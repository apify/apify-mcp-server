import { afterEach, describe, expect, it } from 'vitest';

import { dotFlatten, encodeToon, FENCES, wrapJsonText } from '../../src/utils/encode_text.js';
import { decodeFencedToolText } from './helpers/tool_context.js';

describe('dotFlatten', () => {
    it('lifts nested object keys into dot-joined top-level keys', () => {
        expect(dotFlatten({ id: 1, stats: { runs: 10, reads: 5 } })).toEqual({
            id: 1,
            'stats.runs': 10,
            'stats.reads': 5,
        });
    });

    it('flattens each object element of an array but keeps it an array', () => {
        expect(
            dotFlatten([
                { id: 1, stats: { runs: 10 } },
                { id: 2, stats: { runs: 20 } },
            ]),
        ).toEqual([
            { id: 1, 'stats.runs': 10 },
            { id: 2, 'stats.runs': 20 },
        ]);
    });

    it('leaves scalars, null, and inline scalar arrays unchanged', () => {
        expect(dotFlatten({ a: 1, b: null, tags: ['x', 'y'] })).toEqual({ a: 1, b: null, tags: ['x', 'y'] });
    });

    it('normalises literal dots in source keys to underscores', () => {
        expect(dotFlatten({ 'a.b': 1 })).toEqual({ a_b: 1 });
    });

    it('throws on a normalisation collision (no silent data loss)', () => {
        expect(() => dotFlatten({ 'a.b': 1, a_b: 2 })).toThrow(RangeError);
    });

    it('keeps a top-level key named like an Object.prototype member (no false-positive collision)', () => {
        const flat = dotFlatten({ id: 1, constructor: 'Building Co' }) as Record<string, unknown>;
        expect(flat.id).toBe(1);
        expect(flat.constructor).toBe('Building Co');
    });

    it('keeps an own __proto__ key (from parsed JSON) as data without polluting the prototype', () => {
        const flat = dotFlatten(JSON.parse('{"id":1,"__proto__":"x"}')) as Record<string, unknown>;
        expect(Object.getOwnPropertyDescriptor(flat, '__proto__')?.value).toBe('x');
        expect(Object.getPrototypeOf(flat)).toBe(null);
    });

    it('throws when nesting exceeds the depth guard', () => {
        let deep: Record<string, unknown> = { leaf: 1 };
        for (let i = 0; i < 25; i++) deep = { nest: deep };
        expect(() => dotFlatten(deep)).toThrow(RangeError);
    });
});

describe('wrapJsonText', () => {
    it('emits a ```json … ``` fenced block', () => {
        expect(wrapJsonText({ a: 1 })).toBe('```json\n{"a":1}\n```');
    });

    it('serializes arrays', () => {
        expect(wrapJsonText([1, 2])).toBe('```json\n[1,2]\n```');
    });

    it('serializes primitives', () => {
        expect(wrapJsonText('x')).toBe('```json\n"x"\n```');
    });
});

describe('encodeToon', () => {
    const uniformRows = {
        items: [
            { id: 1, status: 'SUCCEEDED', cost: 0.1 },
            { id: 2, status: 'FAILED', cost: 0.2 },
            { id: 3, status: 'SUCCEEDED', cost: 0.3 },
        ],
    };

    it('emits a TOON fence that round-trips to the original value', () => {
        const text = encodeToon(uniformRows);
        expect(text.startsWith(FENCES.toon.prefix)).toBe(true);
        expect(decodeFencedToolText(text)).toEqual(uniformRows);
    });

    it('preserves Date, nested-object, and null fields (regression: dotFlatten dropped Date objects)', () => {
        const startedAt = '2026-05-12T09:18:27.527Z';
        const input = {
            items: [
                {
                    id: 1,
                    startedAt: new Date(startedAt),
                    finishedAt: new Date('2026-05-12T09:19:01.000Z'),
                    stats: { runs: 10 },
                },
                { id: 2, startedAt: new Date('2026-05-12T09:17:57.206Z'), finishedAt: null, stats: { runs: 20 } },
            ],
        };
        const text = encodeToon(input);

        // The Date must survive as an ISO string. An earlier revision treated a Date as an empty
        // nested object in dotFlatten and dropped it; serialising through JSON first fixes that.
        expect(text).toContain(startedAt);

        // The TOON text round-trips to the dot-flattened, JSON-normalised value.
        const normalized = JSON.parse(JSON.stringify(input));
        expect(text.startsWith(FENCES.toon.prefix)).toBe(true);
        expect(decodeFencedToolText(text)).toEqual(dotFlatten(normalized));
    });

    it('ships TOON for a prototype-name column instead of falling back to JSON', () => {
        const value = {
            items: [
                { id: 1, constructor: 'a' },
                { id: 2, constructor: 'b' },
            ],
        };
        const text = encodeToon(value);
        expect(text.startsWith(FENCES.toon.prefix)).toBe(true);
        expect(decodeFencedToolText(text)).toEqual(value);
    });

    it('falls back to JSON on a dotFlatten collision and still round-trips', () => {
        const value = { 'a.b': 1, a_b: 2 };
        const text = encodeToon(value);
        expect(text.startsWith(FENCES.toon.prefix)).toBe(false);
        expect(decodeFencedToolText(text)).toEqual(value);
    });

    it('falls back to JSON when nesting exceeds the depth guard', () => {
        let deep: Record<string, unknown> = { leaf: 1 };
        for (let i = 0; i < 25; i++) deep = { nest: deep };
        const text = encodeToon(deep);
        expect(text.startsWith(FENCES.toon.prefix)).toBe(false);
        expect(decodeFencedToolText(text)).toEqual(deep);
    });

    describe('APIFY_MCP_DISABLE_TOON override', () => {
        afterEach(() => {
            delete process.env.APIFY_MCP_DISABLE_TOON;
        });

        it.each(['1', 'true'])('ships JSON (not TOON) when set to %s', (flag) => {
            process.env.APIFY_MCP_DISABLE_TOON = flag;
            const text = encodeToon(uniformRows);
            expect(text.startsWith(FENCES.json.prefix)).toBe(true);
            expect(text.startsWith(FENCES.toon.prefix)).toBe(false);
            expect(decodeFencedToolText(text)).toEqual(uniformRows);
        });

        it('still ships TOON for other values (e.g. "0")', () => {
            process.env.APIFY_MCP_DISABLE_TOON = '0';
            const text = encodeToon(uniformRows);
            expect(text.startsWith(FENCES.toon.prefix)).toBe(true);
        });
    });
});
