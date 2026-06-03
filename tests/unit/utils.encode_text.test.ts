import { decode as decodeToon } from '@toon-format/toon';
import { describe, expect, it } from 'vitest';

import { dotFlatten, encodeCompactText } from '../../src/utils/encode_text.js';

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

    it('throws when nesting exceeds the depth guard', () => {
        let deep: Record<string, unknown> = { leaf: 1 };
        for (let i = 0; i < 25; i++) deep = { nest: deep };
        expect(() => dotFlatten(deep)).toThrow(RangeError);
    });
});

/** Decode whichever fence the picker shipped, back to a JSON value. */
function decodeFenced(text: string): unknown {
    if (text.startsWith('```toon\n')) return decodeToon(text.slice('```toon\n'.length, -'\n```'.length));
    return JSON.parse(text.slice('```json\n'.length, -'\n```'.length));
}

const byteLen = (s: string) => Buffer.byteLength(s, 'utf8');

describe('encodeCompactText', () => {
    const uniformRows = {
        items: [
            { id: 1, status: 'SUCCEEDED', cost: 0.1 },
            { id: 2, status: 'FAILED', cost: 0.2 },
            { id: 3, status: 'SUCCEEDED', cost: 0.3 },
        ],
    };

    it('ships TOON when it is smaller and round-trips to the original value', () => {
        const text = encodeCompactText(uniformRows);
        expect(text.startsWith('```toon\n')).toBe(true);
        expect(decodeFenced(text)).toEqual(uniformRows);
    });

    it('never ships more bytes than the plain JSON candidate', () => {
        const jsonBytes = byteLen('```json\n' + JSON.stringify(uniformRows) + '\n```');
        expect(byteLen(encodeCompactText(uniformRows))).toBeLessThanOrEqual(jsonBytes);
    });

    it('falls back to JSON on a dotFlatten collision and still round-trips', () => {
        const value = { 'a.b': 1, a_b: 2 };
        const text = encodeCompactText(value);
        expect(text.startsWith('```json\n')).toBe(true);
        expect(decodeFenced(text)).toEqual(value);
    });

    it('falls back to JSON when nesting exceeds the depth guard', () => {
        let deep: Record<string, unknown> = { leaf: 1 };
        for (let i = 0; i < 25; i++) deep = { nest: deep };
        const text = encodeCompactText(deep);
        expect(text.startsWith('```json\n')).toBe(true);
        expect(decodeFenced(text)).toEqual(deep);
    });
});
