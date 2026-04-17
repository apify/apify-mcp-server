import { describe, expect, it } from 'vitest';

import { typeObjectToString } from '../../src/utils/actor_details.js';

describe('typeObjectToString', () => {
    it('formats a flat object of string-typed fields', () => {
        expect(typeObjectToString({ name: 'string', age: 'number' }))
            .toBe('{ name: string, age: number }');
    });

    it('formats an array of primitives', () => {
        expect(typeObjectToString({ tags: ['string'] }))
            .toBe('{ tags: string[] }');
    });

    it('formats an array of objects', () => {
        expect(typeObjectToString({ users: [{ name: 'string' }] }))
            .toBe('{ users: { name: string }[] }');
    });

    it('formats a nested object', () => {
        expect(typeObjectToString({ profile: { name: 'string', age: 'number' } }))
            .toBe('{ profile: { name: string, age: number } }');
    });

    it('formats deep nesting through arrays and objects', () => {
        expect(typeObjectToString({ a: [{ b: ['string'] }] }))
            .toBe('{ a: { b: string[] }[] }');
    });

    it('returns empty braces for an empty object', () => {
        expect(typeObjectToString({})).toBe('{  }');
    });

    it('returns "unknown[]" for an empty array', () => {
        expect(typeObjectToString({ tags: [] })).toBe('{ tags: unknown[] }');
    });

    it('skips fields with null / number / boolean / undefined values at top level', () => {
        expect(typeObjectToString({
            a: null,
            b: 42,
            c: true,
            d: undefined,
            keep: 'string',
        })).toBe('{ keep: string }');
    });

    it('emits "unknown" for non-string primitives nested inside arrays', () => {
        expect(typeObjectToString({ nums: [42] })).toBe('{ nums: unknown[] }');
    });

    it('formats nested arrays', () => {
        expect(typeObjectToString({ matrix: [['string']] })).toBe('{ matrix: string[][] }');
    });

    it('emits "unknown" for null nested inside an array', () => {
        expect(typeObjectToString({ a: [null] })).toBe('{ a: unknown[] }');
    });

    it('mixes kept string/object/array fields with skipped primitives in one object', () => {
        expect(typeObjectToString({
            name: 'string',
            count: 5,
            tags: ['string'],
            meta: { id: 'string' },
            flag: false,
        })).toBe('{ name: string, tags: string[], meta: { id: string } }');
    });

    it('emits "unknown" for function / symbol nested inside an array', () => {
        expect(typeObjectToString({ fns: [() => 1] as unknown[] })).toBe('{ fns: unknown[] }');
        expect(typeObjectToString({ syms: [Symbol('x')] as unknown[] })).toBe('{ syms: unknown[] }');
    });

    it('formats triple-nested arrays', () => {
        expect(typeObjectToString({ cube: [[['string']]] })).toBe('{ cube: string[][][] }');
    });

    it('formats an array whose element is an empty object', () => {
        expect(typeObjectToString({ items: [{}] })).toBe('{ items: {  }[] }');
    });

    it('recurses through a nested object containing mixed skipped values', () => {
        expect(typeObjectToString({
            outer: {
                keep: 'string',
                skip: 42,
                tags: ['string'],
            },
        })).toBe('{ outer: { keep: string, tags: string[] } }');
    });
});
