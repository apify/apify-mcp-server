import { describe, expect, it } from 'vitest';

import { sanitizeParams } from '../../src/utils/logging.js';

describe('sanitizeParams', () => {
    it('should redact skyfire-pay-id when present', () => {
        const params = { 'skyfire-pay-id': 'secret-token-123', actor: 'apify/web-scraper', url: 'https://example.com' };
        const result = sanitizeParams(params);
        expect(result).toEqual({ 'skyfire-pay-id': '[REDACTED]', actor: 'apify/web-scraper', url: 'https://example.com' });
    });

    it('should return params unchanged when skyfire-pay-id is not present', () => {
        const params = { actor: 'apify/web-scraper', url: 'https://example.com' };
        const result = sanitizeParams(params);
        expect(result).toBe(params); // same reference, no copy
    });

    it('should return null as-is', () => {
        expect(sanitizeParams(null)).toBeNull();
    });

    it('should return undefined as-is', () => {
        expect(sanitizeParams(undefined)).toBeUndefined();
    });

    it('should return primitives as-is', () => {
        expect(sanitizeParams('string')).toBe('string');
        expect(sanitizeParams(42)).toBe(42);
        expect(sanitizeParams(true)).toBe(true);
    });

    it('should return arrays as-is', () => {
        const arr = [1, 2, 3];
        expect(sanitizeParams(arr)).toBe(arr);
    });

    it('should return empty object as-is', () => {
        const params = {};
        expect(sanitizeParams(params)).toBe(params);
    });

    it('should not mutate the original object', () => {
        const params = { 'skyfire-pay-id': 'secret', foo: 'bar' };
        sanitizeParams(params);
        expect(params['skyfire-pay-id']).toBe('secret');
    });

    it('should handle skyfire-pay-id with empty string value', () => {
        const params = { 'skyfire-pay-id': '', other: 'value' };
        const result = sanitizeParams(params);
        expect(result).toEqual({ 'skyfire-pay-id': '[REDACTED]', other: 'value' });
    });
});
