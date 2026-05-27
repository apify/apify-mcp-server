import { describe, expect, it } from 'vitest';

import {
    generateSchemaFromItems,
    type JsonSchemaProperty,
    cleanEmptyArrays,
} from '../../src/utils/schema_generation.js';

/** Extract item-level properties from a generated array schema. */
function props(result: ReturnType<typeof generateSchemaFromItems>): Record<string, JsonSchemaProperty> | undefined {
    if (!result || typeof result.items !== 'object' || !('properties' in result.items)) return undefined;
    return result.items.properties as Record<string, JsonSchemaProperty>;
}

describe('generateSchemaFromItems — basics', () => {
    it('returns null for empty input', () => {
        expect(generateSchemaFromItems([])).toBeNull();
    });

    it('returns null when input is exhausted by slice(0, 0)', () => {
        expect(generateSchemaFromItems([{ a: 1 }], { limit: 0 })).toBeNull();
    });

    it('wraps a single item in an array schema', () => {
        const result = generateSchemaFromItems([{ name: 'John', age: 30 }]);
        expect(result?.type).toBe('array');
        expect(props(result)?.name?.type).toBe('string');
        expect(props(result)?.age?.type).toBe('integer');
    });

    it('infers each primitive type', () => {
        const result = generateSchemaFromItems([
            {
                s: 'x',
                i: 1,
                n: 1.5,
                b: true,
                nul: null,
                o: { nested: 'v' },
                a: [1, 2, 3],
            },
        ]);
        const p = props(result)!;
        expect(p.s?.type).toBe('string');
        expect(p.i?.type).toBe('integer');
        expect(p.n?.type).toBe('number');
        expect(p.b?.type).toBe('boolean');
        expect(p.nul?.type).toBe('null');
        expect(p.o?.type).toBe('object');
        expect(p.a?.type).toBe('array');
        expect(p.a?.items?.type).toBe('integer');
        expect(p.o?.properties?.nested?.type).toBe('string');
    });
});

describe('generateSchemaFromItems — object merge across items', () => {
    // Regression for the `to-json-schema` bug that wiped all properties when any
    // two items had differing key sets. See PR description for details.
    it('merges properties when one item is a strict subset of the other', () => {
        const result = generateSchemaFromItems([
            { a: 'x', b: 1, markdown: 'hello' },
            { a: 'y', b: 2 },
        ]);
        const p = props(result)!;
        expect(p.a?.type).toBe('string');
        expect(p.b?.type).toBe('integer');
        expect(p.markdown?.type).toBe('string');
    });

    it('unions completely disjoint key sets', () => {
        const result = generateSchemaFromItems([{ onlyA: 1 }, { onlyB: 'x' }, { onlyC: true }]);
        const p = props(result)!;
        expect(p.onlyA?.type).toBe('integer');
        expect(p.onlyB?.type).toBe('string');
        expect(p.onlyC?.type).toBe('boolean');
    });

    it('merges nested objects recursively', () => {
        const result = generateSchemaFromItems([
            { metadata: { url: 'https://a.com', title: 'A' } },
            { metadata: { url: 'https://b.com', description: 'desc' } },
        ]);
        const meta = props(result)!.metadata;
        expect(meta?.type).toBe('object');
        expect(meta?.properties?.url?.type).toBe('string');
        expect(meta?.properties?.title?.type).toBe('string');
        expect(meta?.properties?.description?.type).toBe('string');
    });

    it('merges three levels of nesting', () => {
        const result = generateSchemaFromItems([{ a: { b: { c: 1 } } }, { a: { b: { d: 'x' } } }]);
        const c = props(result)!.a?.properties?.b?.properties?.c;
        const d = props(result)!.a?.properties?.b?.properties?.d;
        expect(c?.type).toBe('integer');
        expect(d?.type).toBe('string');
    });
});

describe('generateSchemaFromItems — type unification', () => {
    it('promotes integer + number to number', () => {
        const result = generateSchemaFromItems([{ x: 1 }, { x: 1.5 }]);
        expect(props(result)!.x?.type).toBe('number');
    });

    it('emits a type array for number + string conflict', () => {
        const result = generateSchemaFromItems([{ x: 1 }, { x: 'hi' }]);
        const t = props(result)!.x?.type;
        expect(Array.isArray(t)).toBe(true);
        expect(new Set(t as string[])).toEqual(new Set(['integer', 'string']));
    });

    it('emits a type array for string + null', () => {
        const result = generateSchemaFromItems([{ x: 'foo' }, { x: null }]);
        const t = props(result)!.x?.type;
        expect(Array.isArray(t)).toBe(true);
        expect(new Set(t as string[])).toEqual(new Set(['string', 'null']));
    });

    it('emits a type array for three different primitives', () => {
        const result = generateSchemaFromItems([{ x: 1 }, { x: 'hi' }, { x: true }]);
        const t = props(result)!.x?.type;
        expect(Array.isArray(t)).toBe(true);
        expect(new Set(t as string[])).toEqual(new Set(['integer', 'string', 'boolean']));
    });

    it('keeps object sub-shape when type is object|string union', () => {
        // The `properties` ride along the union type; per JSON Schema spec,
        // validators ignore `properties` for non-object instances.
        const result = generateSchemaFromItems([{ x: { foo: 1 } }, { x: 'hi' }]);
        const { x } = props(result)!;
        expect(new Set(x?.type as string[])).toEqual(new Set(['object', 'string']));
        expect(x?.properties?.foo?.type).toBe('integer');
    });

    it('keeps array items shape when type is array|string union', () => {
        const result = generateSchemaFromItems([{ x: [1, 2] }, { x: 'hi' }]);
        const { x } = props(result)!;
        expect(new Set(x?.type as string[])).toEqual(new Set(['array', 'string']));
        expect(x?.items?.type).toBe('integer');
    });

    it('unions primitive types inside nested arrays', () => {
        const result = generateSchemaFromItems([{ a: [1, 'x', true] }]);
        const inner = props(result)!.a?.items?.type;
        expect(Array.isArray(inner)).toBe(true);
        expect(new Set(inner as string[])).toEqual(new Set(['integer', 'string', 'boolean']));
    });
});

describe('generateSchemaFromItems — format detection', () => {
    it('detects uri, date-time, date, email, uuid', () => {
        const result = generateSchemaFromItems([
            {
                url: 'https://example.com/path?q=1',
                dt: '2025-05-16T14:00:00Z',
                d: '2025-05-16',
                email: 'a@b.com',
                id: '550e8400-e29b-41d4-a716-446655440000',
            },
        ]);
        const p = props(result)!;
        expect(p.url?.format).toBe('uri');
        expect(p.dt?.format).toBe('date-time');
        expect(p.d?.format).toBe('date');
        expect(p.email?.format).toBe('email');
        expect(p.id?.format).toBe('uuid');
    });

    it('does not flag free-form text as a format (no `style`/`color`/`hostname` false positives)', () => {
        // Previously the old library emitted `format: "style"` on Markdown bodies
        // because the CSS-ish regex matched any `:` followed by `;`.
        const result = generateSchemaFromItems([
            {
                markdown: '# Heading\n\nSome **bold**: text; with punctuation.\n\n[link](http://x)',
                plain: 'just a sentence with: stuff; in it',
                cssLike: 'color: red; padding: 10px;',
            },
        ]);
        const p = props(result)!;
        expect(p.markdown?.format).toBeUndefined();
        expect(p.plain?.format).toBeUndefined();
        expect(p.cssLike?.format).toBeUndefined();
    });

    it('drops format when items disagree (some formatted, some plain)', () => {
        const result = generateSchemaFromItems([{ url: 'https://example.com' }, { url: 'not a url' }]);
        expect(props(result)!.url?.type).toBe('string');
        expect(props(result)!.url?.format).toBeUndefined();
    });
});

describe('generateSchemaFromItems — arrays inside items', () => {
    it('preserves empty arrays as untyped array schema (when clean=false)', () => {
        const result = generateSchemaFromItems([{ tags: [] }], { clean: false });
        expect(props(result)!.tags?.type).toBe('array');
        expect(props(result)!.tags?.items).toBeUndefined();
    });

    it('merges item schemas across heterogeneous object arrays', () => {
        const result = generateSchemaFromItems([
            {
                items: [
                    { sku: 'A', price: 10 },
                    { sku: 'B', stock: 5 },
                ],
            },
        ]);
        const inner = props(result)!.items?.items;
        expect(inner?.type).toBe('object');
        expect(inner?.properties?.sku?.type).toBe('string');
        expect(inner?.properties?.price?.type).toBe('integer');
        expect(inner?.properties?.stock?.type).toBe('integer');
    });
});

describe('generateSchemaFromItems — options', () => {
    it('respects `limit` — fields appearing only past the limit are excluded', () => {
        const items = [
            { id: 1, name: 'A' },
            { id: 2, name: 'B' },
            { id: 3, name: 'C' },
            { id: 4, extra: 'D' },
            { id: 5, extra: 'E' },
        ];
        const p = props(generateSchemaFromItems(items, { limit: 3 }))!;
        expect(p.id?.type).toBe('integer');
        expect(p.name?.type).toBe('string');
        expect(p.extra).toBeUndefined();
    });

    it('clean=true (default) strips empty arrays before inference', () => {
        const p = props(generateSchemaFromItems([{ kept: 'x', dropped: [] }]))!;
        expect(p.kept).toBeDefined();
        expect(p.dropped).toBeUndefined();
    });

    it('clean=false keeps empty arrays', () => {
        const p = props(generateSchemaFromItems([{ kept: 'x', dropped: [] }], { clean: false }))!;
        expect(p.kept).toBeDefined();
        expect(p.dropped?.type).toBe('array');
    });
});

describe('generateSchemaFromItems — user-reported regression', () => {
    it('emits all four top-level keys from the NYC sushi dataset sample', () => {
        const items = [
            {
                'metadata.url': 'https://thesushilegend.com/best-nyc-sushi/',
                'metadata.title': 'The Best Sushi In New York',
                'searchResult.resultType': 'ORGANIC',
                markdown: 'long markdown body',
            },
            {
                'metadata.url': 'https://www.tripadvisor.com/Restaurants.html',
                'metadata.title': '',
                'searchResult.resultType': 'ORGANIC',
            },
            {
                'metadata.url': 'https://guide.michelin.com/',
                'metadata.title': '',
                'searchResult.resultType': 'ORGANIC',
                markdown: '',
            },
            {
                'metadata.url': 'https://ny.eater.com/maps/best-sushi-nyc',
                'metadata.title': 'Best Sushi Restaurants',
                'searchResult.resultType': 'ORGANIC',
                markdown: 'eater markdown',
            },
            {
                'metadata.url': 'https://www.instagram.com/reel/abc/',
                'metadata.title': 'Instagram',
                'searchResult.resultType': 'ORGANIC',
                markdown: 'instagram markdown',
            },
        ];
        const p = props(generateSchemaFromItems(items))!;
        expect(Object.keys(p).sort()).toEqual([
            'markdown',
            'metadata.title',
            'metadata.url',
            'searchResult.resultType',
        ]);
        expect(p['metadata.url']?.format).toBe('uri');
        expect(p.markdown?.format).toBeUndefined(); // no `style` false positive
    });
});

describe('cleanEmptyArrays', () => {
    it('drops keys whose value is an empty array', () => {
        expect(cleanEmptyArrays({ kept: 1, dropped: [] })).toEqual({ kept: 1 });
    });

    it('recurses into nested objects', () => {
        expect(cleanEmptyArrays({ a: { kept: 1, dropped: [] } })).toEqual({ a: { kept: 1 } });
    });

    it('recurses into array elements', () => {
        expect(cleanEmptyArrays([{ x: [] }, { y: 1 }])).toEqual([{}, { y: 1 }]);
    });

    it('preserves primitives, null, and non-empty arrays', () => {
        expect(cleanEmptyArrays(null)).toBeNull();
        expect(cleanEmptyArrays(42)).toBe(42);
        expect(cleanEmptyArrays('s')).toBe('s');
        expect(cleanEmptyArrays([1, 2, 3])).toEqual([1, 2, 3]);
    });
});
