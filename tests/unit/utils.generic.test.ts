import { describe, expect, it } from 'vitest';

import {
    computeValueBytes,
    parseCommaSeparatedList,
    parseQueryParamList,
    redactApiTokens,
    stripQuoteWrappers,
} from '../../src/utils/generic.js';

describe('API tokens are redacted from text', () => {
    it('replaces a token', () => {
        expect(redactApiTokens(`Bearer apify_api_${'a1B2'.repeat(9)} failed`)).toBe('Bearer apify_api_*** failed');
    });

    // Stack traces in log lines name files such as `src/tools/api/apify_api_request.ts`.
    it('keeps a file name that starts like a token', () => {
        const stack = 'at callApi (/app/dist/tools/api/apify_api_request.js:42:7)';
        expect(redactApiTokens(stack)).toBe(stack);
    });

    // A greedy match would take the `apify` of the second token and leave its secret part in the text.
    it('replaces two tokens joined with no separator', () => {
        const token = `apify_api_${'a1B2'.repeat(9)}`;
        expect(redactApiTokens(`${token}${token}`)).toBe('apify_api_***apify_api_***');
    });

    // Log lines and telemetry carry caller input of any length; the redaction must not throw on it.
    it('replaces a token followed by a multi-megabyte run of alphanumerics', () => {
        expect(redactApiTokens(`apify_api_${'a'.repeat(10_000_000)} end`)).toBe('apify_api_*** end');
    });
});

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

    it('reduces an id of only quotes to an empty string', () => {
        expect(stripQuoteWrappers('`""`')).toBe('');
    });

    // Linear time takes well under a millisecond here; the bound only catches time that grows faster than the length.
    it('strips a 100,000-character id with a quote run inside it within a second', () => {
        const id = `a${'`'.repeat(100_000)}a`;

        const startedAt = performance.now();
        expect(stripQuoteWrappers(id)).toBe(id);
        expect(performance.now() - startedAt).toBeLessThan(1000);
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
