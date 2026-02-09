import { describe, expect, it } from 'vitest';

import { redactSkyfirePayId } from '../../src/utils/logging.js';

describe('redactSkyfirePayId', () => {
    it('should redact skyfire-pay-id when present', () => {
        const params = { 'skyfire-pay-id': 'secret-token-123', actor: 'apify/web-scraper', url: 'https://example.com' };
        const result = redactSkyfirePayId(params);
        expect(result).toEqual({ 'skyfire-pay-id': '[REDACTED]', actor: 'apify/web-scraper', url: 'https://example.com' });
    });

    it('should return params unchanged when skyfire-pay-id is not present', () => {
        const params = { actor: 'apify/web-scraper', url: 'https://example.com' };
        const result = redactSkyfirePayId(params);
        expect(result).toBe(params); // same reference, no copy
    });

    it('should return null as-is', () => {
        expect(redactSkyfirePayId(null)).toBeNull();
    });

    it('should return undefined as-is', () => {
        expect(redactSkyfirePayId(undefined)).toBeUndefined();
    });

    it('should return primitives as-is', () => {
        expect(redactSkyfirePayId('string')).toBe('string');
        expect(redactSkyfirePayId(42)).toBe(42);
        expect(redactSkyfirePayId(true)).toBe(true);
    });

    it('should return arrays as-is', () => {
        const arr = [1, 2, 3];
        expect(redactSkyfirePayId(arr)).toBe(arr);
    });

    it('should return empty object as-is', () => {
        const params = {};
        expect(redactSkyfirePayId(params)).toBe(params);
    });

    it('should not mutate the original object', () => {
        const params = { 'skyfire-pay-id': 'secret', foo: 'bar' };
        redactSkyfirePayId(params);
        expect(params['skyfire-pay-id']).toBe('secret');
    });

    it('should handle skyfire-pay-id with empty string value', () => {
        const params = { 'skyfire-pay-id': '', other: 'value' };
        const result = redactSkyfirePayId(params);
        expect(result).toEqual({ 'skyfire-pay-id': '[REDACTED]', other: 'value' });
    });

    it('should not redact if already redacted', () => {
        const params = { 'skyfire-pay-id': '[REDACTED]', other: 'value' };
        const result = redactSkyfirePayId(params);
        expect(result).toBe(params); // same reference, already redacted
    });
});
