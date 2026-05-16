import { describe, expect, it } from 'vitest';

import { generateSchemaFromItems, type JsonSchemaProperty } from '../../src/utils/schema_generation.js';

const props = (r: ReturnType<typeof generateSchemaFromItems>) => (r?.items as { properties?: Record<string, JsonSchemaProperty> } | undefined)?.properties;

const setT = (p?: JsonSchemaProperty) => new Set(Array.isArray(p?.type) ? p.type : [p?.type]);

describe('generateSchemaFromItems', () => {
    it('returns null for empty input', () => {
        expect(generateSchemaFromItems([])).toBeNull();
        expect(generateSchemaFromItems([{ a: 1 }], { limit: 0 })).toBeNull();
    });

    it('infers all primitive types', () => {
        const p = props(generateSchemaFromItems([{ s: 'x', i: 1, n: 1.5, b: true, nul: null }]));
        expect(p?.s?.type).toBe('string');
        expect(p?.i?.type).toBe('integer');
        expect(p?.n?.type).toBe('number');
        expect(p?.b?.type).toBe('boolean');
        expect(p?.nul?.type).toBe('null');
    });

    // Regression: pre-fix this collapsed to `{ type: 'object' }` with zero properties.
    it('merges keys across items where one is a strict subset of the other', () => {
        const p = props(generateSchemaFromItems([{ a: 'x', b: 1, md: 'h' }, { a: 'y', b: 2 }]));
        expect(p?.a?.type).toBe('string');
        expect(p?.b?.type).toBe('integer');
        expect(p?.md?.type).toBe('string');
    });

    it('merges nested objects recursively', () => {
        const p = props(generateSchemaFromItems([{ m: { u: 'A', t: 'T' } }, { m: { u: 'B', d: 'D' } }]));
        expect(p?.m?.type).toBe('object');
        expect(new Set(Object.keys(p?.m?.properties ?? {}))).toEqual(new Set(['u', 't', 'd']));
    });

    it('merges nested arrays of objects with differing keys', () => {
        const p = props(generateSchemaFromItems([{ items: [{ sku: 'A', price: 10 }, { sku: 'B', stock: 5 }] }]));
        expect(new Set(Object.keys(p?.items?.items?.properties ?? {}))).toEqual(new Set(['sku', 'price', 'stock']));
    });

    it.each([
        ['integer + number → number', [{ x: 1 }, { x: 1.5 }], new Set(['number'])],
        ['number + string → union', [{ x: 1 }, { x: 'hi' }], new Set(['integer', 'string'])],
        ['string + null → union', [{ x: 'a' }, { x: null }], new Set(['string', 'null'])],
        ['three primitives → union', [{ x: 1 }, { x: 'hi' }, { x: true }], new Set(['integer', 'string', 'boolean'])],
        ['object + string keeps sub-shape', [{ x: { foo: 1 } }, { x: 'hi' }], new Set(['object', 'string'])],
        ['array + string keeps items', [{ x: [1, 2] }, { x: 'hi' }], new Set(['array', 'string'])],
    ])('type unification: %s', (_, items, expected) => {
        expect(setT(props(generateSchemaFromItems(items))?.x)).toEqual(expected);
    });

    it.each([
        ['uri', 'https://example.com/x'],
        ['date-time', '2025-05-16T12:00:00Z'],
        ['date', '2025-05-16'],
        ['email', 'a@b.com'],
        ['uuid', '550e8400-e29b-41d4-a716-446655440000'],
    ])('detects format: %s', (format, value) => {
        expect(props(generateSchemaFromItems([{ x: value }]))?.x).toEqual({ type: 'string', format });
    });

    it('no false-positive formats on free-form text', () => {
        const p = props(generateSchemaFromItems([{ md: '# Heading\n\ncolor: red; padding: 10px;', plain: 'a: b; c: d' }]));
        expect(p?.md?.format).toBeUndefined();
        expect(p?.plain?.format).toBeUndefined();
    });

    it('drops format when items disagree', () => {
        const p = props(generateSchemaFromItems([{ u: 'https://a.com' }, { u: 'plain text' }]));
        expect(p?.u?.format).toBeUndefined();
    });

    it('respects limit', () => {
        const p = props(generateSchemaFromItems([{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4, extra: 'x' }], { limit: 3 }));
        expect(p?.extra).toBeUndefined();
    });

    it('clean=true strips empty arrays; clean=false keeps them', () => {
        expect(props(generateSchemaFromItems([{ k: 'x', dropped: [] }]))?.dropped).toBeUndefined();
        expect(props(generateSchemaFromItems([{ k: 'x', dropped: [] }], { clean: false }))?.dropped?.type).toBe('array');
    });

    it('regression: user-reported NYC sushi dataset emits all top-level keys', () => {
        const p = props(generateSchemaFromItems([
            { 'metadata.url': 'https://a.com', 'metadata.title': 'A', md: 'body' },
            { 'metadata.url': 'https://b.com', 'metadata.title': '' },
            { 'metadata.url': 'https://c.com', 'metadata.title': 'C', md: '' },
        ]));
        expect(Object.keys(p ?? {}).sort()).toEqual(['md', 'metadata.title', 'metadata.url']);
        expect(p?.['metadata.url']?.format).toBe('uri');
        expect(p?.md?.format).toBeUndefined();
    });
});
