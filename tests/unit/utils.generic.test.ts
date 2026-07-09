import { describe, expect, it } from 'vitest';

import { parseBooleanOrNull } from '@apify/utilities';

import { parseCommaSeparatedList, parseQueryParamList, stripQuoteWrappers } from '../../src/utils/generic.js';

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

describe('stripQuoteWrappers', () => {
    it('returns the input unchanged when no wrappers or whitespace are present', () => {
        expect(stripQuoteWrappers('ds-1')).toBe('ds-1');
        expect(stripQuoteWrappers('user~my-dataset')).toBe('user~my-dataset');
    });

    it('trims surrounding whitespace', () => {
        expect(stripQuoteWrappers('  ds-1  ')).toBe('ds-1');
    });

    it('strips matched markdown backtick wrappers', () => {
        expect(stripQuoteWrappers('`user~my-store`')).toBe('user~my-store');
    });

    it('strips matched straight double-quote wrappers', () => {
        expect(stripQuoteWrappers('"ds-1"')).toBe('ds-1');
    });

    it('strips matched smart-quote wrappers', () => {
        expect(stripQuoteWrappers('“ds-1”')).toBe('ds-1');
        expect(stripQuoteWrappers('‘ds-1’')).toBe('ds-1');
    });

    it('strips nested wrappers (matched pair + trailing regex)', () => {
        expect(stripQuoteWrappers('`"ds-1"`')).toBe('ds-1');
    });

    it('strips unpaired leading/trailing quote noise', () => {
        expect(stripQuoteWrappers('ds-1"')).toBe('ds-1');
        expect(stripQuoteWrappers('`ds-1')).toBe('ds-1');
    });
});

describe('parseBooleanOrNull', () => {
    it('should return boolean values directly', () => {
        expect(parseBooleanOrNull(true)).toBe(true);
        expect(parseBooleanOrNull(false)).toBe(false);
    });

    it('should parse "true" and "1" as true', () => {
        expect(parseBooleanOrNull('true')).toBe(true);
        expect(parseBooleanOrNull('TRUE')).toBe(true);
        expect(parseBooleanOrNull('True')).toBe(true);
        expect(parseBooleanOrNull('1')).toBe(true);
        expect(parseBooleanOrNull('  true  ')).toBe(true);
        expect(parseBooleanOrNull('  1  ')).toBe(true);
    });

    it('should parse "false" and "0" as false', () => {
        expect(parseBooleanOrNull('false')).toBe(false);
        expect(parseBooleanOrNull('FALSE')).toBe(false);
        expect(parseBooleanOrNull('False')).toBe(false);
        expect(parseBooleanOrNull('0')).toBe(false);
        expect(parseBooleanOrNull('  false  ')).toBe(false);
        expect(parseBooleanOrNull('  0  ')).toBe(false);
    });

    it('should return null for null and undefined', () => {
        expect(parseBooleanOrNull(null)).toBeNull();
        expect(parseBooleanOrNull(undefined)).toBeNull();
    });

    it('should return null for empty strings', () => {
        expect(parseBooleanOrNull('')).toBeNull();
        expect(parseBooleanOrNull('   ')).toBeNull();
        expect(parseBooleanOrNull('\t')).toBeNull();
        expect(parseBooleanOrNull('\n')).toBeNull();
    });

    it('should return null for unrecognized strings', () => {
        expect(parseBooleanOrNull('yes')).toBeNull();
        expect(parseBooleanOrNull('no')).toBeNull();
        expect(parseBooleanOrNull('2')).toBeNull();
        expect(parseBooleanOrNull('maybe')).toBeNull();
        expect(parseBooleanOrNull('on')).toBeNull();
        expect(parseBooleanOrNull('off')).toBeNull();
    });
});
