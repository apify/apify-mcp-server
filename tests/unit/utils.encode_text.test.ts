import { describe, expect, it } from 'vitest';

import { dotFlatten, encodeSmallest, FENCES, wrapJsonText } from '../../src/utils/encode_text.js';
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

    it('throws when nesting exceeds the depth guard', () => {
        let deep: Record<string, unknown> = { leaf: 1 };
        for (let i = 0; i < 25; i++) deep = { nest: deep };
        expect(() => dotFlatten(deep)).toThrow(RangeError);
    });
});

const byteLen = (s: string) => Buffer.byteLength(s, 'utf8');

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

describe('encodeSmallest', () => {
    const uniformRows = {
        items: [
            { id: 1, status: 'SUCCEEDED', cost: 0.1 },
            { id: 2, status: 'FAILED', cost: 0.2 },
            { id: 3, status: 'SUCCEEDED', cost: 0.3 },
        ],
    };

    it('ships TOON when it is smaller and round-trips to the original value', () => {
        const text = encodeSmallest(uniformRows);
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
        const text = encodeSmallest(input);

        // The Date must survive as an ISO string. Before the fix, dotFlatten treated a Date as an
        // empty nested object and dropped it, so the lossy (smaller) candidate won the byte compare.
        expect(text).toContain(startedAt);

        // Whichever candidate ships, the text must round-trip to the JSON-normalised value
        // (dot-flattened when TOON wins).
        const normalized = JSON.parse(JSON.stringify(input));
        const expected = text.startsWith(FENCES.toon.prefix) ? dotFlatten(normalized) : normalized;
        expect(decodeFencedToolText(text)).toEqual(expected);
    });

    it('never ships more bytes than the plain JSON candidate', () => {
        const jsonBytes = byteLen(FENCES.json.prefix + JSON.stringify(uniformRows) + FENCES.json.suffix);
        expect(byteLen(encodeSmallest(uniformRows))).toBeLessThanOrEqual(jsonBytes);
    });

    it('falls back to JSON on a dotFlatten collision and still round-trips', () => {
        const value = { 'a.b': 1, a_b: 2 };
        const text = encodeSmallest(value);
        expect(text.startsWith(FENCES.toon.prefix)).toBe(false);
        expect(decodeFencedToolText(text)).toEqual(value);
    });

    it('falls back to JSON when nesting exceeds the depth guard', () => {
        let deep: Record<string, unknown> = { leaf: 1 };
        for (let i = 0; i < 25; i++) deep = { nest: deep };
        const text = encodeSmallest(deep);
        expect(text.startsWith(FENCES.toon.prefix)).toBe(false);
        expect(decodeFencedToolText(text)).toEqual(deep);
    });
});
