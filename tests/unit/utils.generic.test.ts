import { describe, expect, it } from 'vitest';

import {
    computeValueBytes,
    parseCommaSeparatedList,
    parseQueryParamList,
    stripQuoteWrappers,
} from '../../src/utils/generic.js';

describe('parseCommaSeparatedList', () => {
    it('parses comma-separated list with trimming', () => {
        const result = parseCommaSeparatedList('field1, field2,field3 ');
        expect(result).toEqual(['field1', 'field2', 'field3']);
    });

    it('handles empty input', () => {
        const result = parseCommaSeparatedList();
        expect(result).toEqual([]);
    });

    it('handles empty string', () => {
        const result = parseCommaSeparatedList('');
        expect(result).toEqual([]);
    });

    it('filters empty strings', () => {
        const result = parseCommaSeparatedList(' field1, , field2,,field3 ');
        expect(result).toEqual(['field1', 'field2', 'field3']);
    });

    it('handles only commas and spaces', () => {
        const result = parseCommaSeparatedList(' ,  , ');
        expect(result).toEqual([]);
    });

    it('handles a single item', () => {
        const result = parseCommaSeparatedList(' single ');
        expect(result).toEqual(['single']);
    });
});

describe('parseQueryParamList', () => {
    it('parses a comma-separated string', () => {
        const result = parseQueryParamList('tool1, tool2, tool3');
        expect(result).toEqual(['tool1', 'tool2', 'tool3']);
    });

    it('parses a comma-separated string without spaces', () => {
        const result = parseQueryParamList('tool1,tool2,tool3');
        expect(result).toEqual(['tool1', 'tool2', 'tool3']);
    });

    it('parses an array of strings', () => {
        const result = parseQueryParamList(['tool1', 'tool2', 'tool3']);
        expect(result).toEqual(['tool1', 'tool2', 'tool3']);
    });

    it('handles undefined input', () => {
        const result = parseQueryParamList(undefined);
        expect(result).toEqual([]);
    });

    it('handles an empty string', () => {
        const result = parseQueryParamList('');
        expect(result).toEqual([]);
    });

    it('handles an empty array', () => {
        const result = parseQueryParamList([]);
        expect(result).toEqual([]);
    });

    it('flattens an array with comma-separated values', () => {
        const result = parseQueryParamList(['tool1, tool2', 'tool3, tool4']);
        expect(result).toEqual(['tool1', 'tool2', 'tool3', 'tool4']);
    });

    it('filters empty strings from an array', () => {
        const result = parseQueryParamList(['tool1', '', 'tool2']);
        expect(result).toEqual(['tool1', 'tool2']);
    });

    it('handles a single tool in a string', () => {
        const result = parseQueryParamList('single-tool');
        expect(result).toEqual(['single-tool']);
    });

    it('handles a single tool in an array', () => {
        const result = parseQueryParamList(['single-tool']);
        expect(result).toEqual(['single-tool']);
    });

    it('trims whitespace from array items and their comma-separated values', () => {
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

describe('computeValueBytes()', () => {
    it('counts UTF-8 bytes in strings and buffers', () => {
        expect(computeValueBytes('é')).toBe(2);
        expect(computeValueBytes(Buffer.from('é'))).toBe(2);
    });

    it('counts serialized bytes in objects', () => {
        expect(computeValueBytes({ name: 'é' })).toBe(Buffer.byteLength('{"name":"é"}'));
    });

    it('returns undefined when a value cannot be serialized', () => {
        const circular: { self?: unknown } = {};
        circular.self = circular;
        expect(computeValueBytes(circular)).toBeUndefined();
    });
});
