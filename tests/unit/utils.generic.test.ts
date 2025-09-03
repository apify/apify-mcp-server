import { describe, expect, it } from 'vitest';

import { getValuesByDotKeys } from '../../src/utils/generic.js';

describe('getValuesByDotKeys', () => {
    it('should get value for a key without dot', () => {
        const obj = { key: 'value', other: 123 };
        const result = getValuesByDotKeys(obj, ['key']);
        expect(result).toEqual({ key: 'value' });
    });
    it('should get values for simple keys', () => {
        const obj = { a: 1, b: 2 };
        const result = getValuesByDotKeys(obj, ['a', 'b', 'c']);
        expect(result).toEqual({ a: 1, b: 2, c: undefined });
    });

    it('should get values for nested dot keys', () => {
        const obj = { a: { b: { c: 42 } }, x: { y: 7 } };
        const result = getValuesByDotKeys(obj, ['a.b.c', 'x.y', 'a.b', 'x.z']);
        expect(result).toEqual({ 'a.b.c': 42, 'x.y': 7, 'a.b': { c: 42 }, 'x.z': undefined });
    });

    it('should return undefined for missing paths', () => {
        const obj = { foo: { bar: 1 } };
        const result = getValuesByDotKeys(obj, ['foo.baz', 'baz', 'foo.bar.baz']);
        expect(result).toEqual({ 'foo.baz': undefined, baz: undefined, 'foo.bar.baz': undefined });
    });

    it('should handle non-object values in the path', () => {
        const obj = { a: { b: 5 }, x: 10 };
        const result = getValuesByDotKeys(obj, ['a.b', 'x.y', 'x']);
        expect(result).toEqual({ 'a.b': 5, 'x.y': undefined, x: 10 });
    });

    it('should work with empty keys array', () => {
        const obj = { a: 1 };
        const result = getValuesByDotKeys(obj, []);
        expect(result).toEqual({});
    });

    it('should work with empty object', () => {
        const obj = {};
        const result = getValuesByDotKeys(obj, ['a', 'b.c']);
        expect(result).toEqual({ a: undefined, 'b.c': undefined });
    });

    it('should return whole object', () => {
        const obj = { nested: { a: 1, b: 2 } };
        const result = getValuesByDotKeys(obj, ['nested']);
        expect(result).toEqual({ nested: { a: 1, b: 2 } });
    });
});
