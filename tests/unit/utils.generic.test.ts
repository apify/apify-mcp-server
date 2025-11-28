import { describe, expect, it } from 'vitest';

import { getValuesByDotKeys, isValidHttpUrl, parseBooleanFromString, parseCommaSeparatedList, parseQueryParamList } from '../../src/utils/generic.js';

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

describe('parseCommaSeparatedList', () => {
    it('should parse comma-separated list with trimming', () => {
        const result = parseCommaSeparatedList('field1, field2,field3 ');
        expect(result).toEqual(['field1', 'field2', 'field3']);
    });

    it('should handle empty input', () => {
        const result = parseCommaSeparatedList();
        expect(result).toEqual([]);
    });

    it('should handle empty string', () => {
        const result = parseCommaSeparatedList('');
        expect(result).toEqual([]);
    });

    it('should filter empty strings', () => {
        const result = parseCommaSeparatedList(' field1, , field2,,field3 ');
        expect(result).toEqual(['field1', 'field2', 'field3']);
    });

    it('should handle only commas and spaces', () => {
        const result = parseCommaSeparatedList(' ,  , ');
        expect(result).toEqual([]);
    });

    it('should handle single item', () => {
        const result = parseCommaSeparatedList(' single ');
        expect(result).toEqual(['single']);
    });
});

describe('parseQueryParamList', () => {
    it('should parse comma-separated string', () => {
        const result = parseQueryParamList('tool1, tool2, tool3');
        expect(result).toEqual(['tool1', 'tool2', 'tool3']);
    });

    it('should parse comma-separated string without spaces', () => {
        const result = parseQueryParamList('tool1,tool2,tool3');
        expect(result).toEqual(['tool1', 'tool2', 'tool3']);
    });

    it('should parse array of strings', () => {
        const result = parseQueryParamList(['tool1', 'tool2', 'tool3']);
        expect(result).toEqual(['tool1', 'tool2', 'tool3']);
    });

    it('should handle undefined input', () => {
        const result = parseQueryParamList(undefined);
        expect(result).toEqual([]);
    });

    it('should handle empty string', () => {
        const result = parseQueryParamList('');
        expect(result).toEqual([]);
    });

    it('should handle empty array', () => {
        const result = parseQueryParamList([]);
        expect(result).toEqual([]);
    });

    it('should flatten array with comma-separated values', () => {
        const result = parseQueryParamList(['tool1, tool2', 'tool3, tool4']);
        expect(result).toEqual(['tool1', 'tool2', 'tool3', 'tool4']);
    });

    it('should filter empty strings from array', () => {
        const result = parseQueryParamList(['tool1', '', 'tool2']);
        expect(result).toEqual(['tool1', 'tool2']);
    });

    it('should handle single tool in string', () => {
        const result = parseQueryParamList('single-tool');
        expect(result).toEqual(['single-tool']);
    });

    it('should handle single tool in array', () => {
        const result = parseQueryParamList(['single-tool']);
        expect(result).toEqual(['single-tool']);
    });

    it('should trim whitespace from array items and their comma-separated values', () => {
        const result = parseQueryParamList([' tool1 , tool2 ', ' tool3']);
        expect(result).toEqual(['tool1', 'tool2', 'tool3']);
    });
});

describe('isValidUrl', () => {
    it('should validate correct URLs', () => {
        expect(isValidHttpUrl('http://example.com')).toBe(true);
        expect(isValidHttpUrl('https://example.com/path?query=string#hash')).toBe(true);
        expect(isValidHttpUrl('http://localhost:3000')).toBe(true);
        expect(isValidHttpUrl('http://192.168.1.1')).toBe(true);
    });

    it('should invalidate incorrect URLs', () => {
        expect(isValidHttpUrl('ftp://example.com')).toBe(false);
        expect(isValidHttpUrl('example.com')).toBe(false);
        expect(isValidHttpUrl('http:/example.com')).toBe(false);
        expect(isValidHttpUrl('')).toBe(false);
        expect(isValidHttpUrl('   ')).toBe(false);
        expect(isValidHttpUrl('http//example.com')).toBe(false);
        expect(isValidHttpUrl('https//example.com')).toBe(false);
        expect(isValidHttpUrl('://example.com')).toBe(false);
    });
});

describe('parseBooleanFromString', () => {
    it('should return boolean values directly', () => {
        expect(parseBooleanFromString(true)).toBe(true);
        expect(parseBooleanFromString(false)).toBe(false);
    });

    it('should parse "true" and "1" as true', () => {
        expect(parseBooleanFromString('true')).toBe(true);
        expect(parseBooleanFromString('TRUE')).toBe(true);
        expect(parseBooleanFromString('True')).toBe(true);
        expect(parseBooleanFromString('1')).toBe(true);
        expect(parseBooleanFromString('  true  ')).toBe(true);
        expect(parseBooleanFromString('  1  ')).toBe(true);
    });

    it('should parse "false" and "0" as false', () => {
        expect(parseBooleanFromString('false')).toBe(false);
        expect(parseBooleanFromString('FALSE')).toBe(false);
        expect(parseBooleanFromString('False')).toBe(false);
        expect(parseBooleanFromString('0')).toBe(false);
        expect(parseBooleanFromString('  false  ')).toBe(false);
        expect(parseBooleanFromString('  0  ')).toBe(false);
    });

    it('should return undefined for null and undefined', () => {
        expect(parseBooleanFromString(null)).toBeUndefined();
        expect(parseBooleanFromString(undefined)).toBeUndefined();
    });

    it('should return undefined for empty strings', () => {
        expect(parseBooleanFromString('')).toBeUndefined();
        expect(parseBooleanFromString('   ')).toBeUndefined();
        expect(parseBooleanFromString('\t')).toBeUndefined();
        expect(parseBooleanFromString('\n')).toBeUndefined();
    });

    it('should return undefined for unrecognized strings', () => {
        expect(parseBooleanFromString('yes')).toBeUndefined();
        expect(parseBooleanFromString('no')).toBeUndefined();
        expect(parseBooleanFromString('2')).toBeUndefined();
        expect(parseBooleanFromString('maybe')).toBeUndefined();
        expect(parseBooleanFromString('on')).toBeUndefined();
        expect(parseBooleanFromString('off')).toBeUndefined();
    });
});
