import { describe, expect, it } from 'vitest';

import { SkyfirePaymentProvider } from '../../src/payments/skyfire.js';

const provider = new SkyfirePaymentProvider();

describe('SkyfirePaymentProvider.redactForLogging()', () => {
    it('passes through non-record values unchanged', () => {
        expect(provider.redactForLogging(null)).toBeNull();
        expect(provider.redactForLogging(undefined)).toBeUndefined();
        expect(provider.redactForLogging('string')).toBe('string');
        expect(provider.redactForLogging(42)).toBe(42);
        const arr = [1, 2, 3];
        expect(provider.redactForLogging(arr)).toBe(arr);
    });

    it('returns object as-is when skyfire-pay-id is absent', () => {
        const params = { actor: 'apify/web-scraper', url: 'https://example.com' };
        expect(provider.redactForLogging(params)).toBe(params);
    });

    it('redacts skyfire-pay-id without mutating the original', () => {
        const params = { 'skyfire-pay-id': 'secret-token-123', actor: 'apify/web-scraper' };
        const result = provider.redactForLogging(params);
        expect(result).toEqual({ 'skyfire-pay-id': '[REDACTED]', actor: 'apify/web-scraper' });
        expect(params['skyfire-pay-id']).toBe('secret-token-123');
    });

    it('skips redaction if already redacted', () => {
        const params = { 'skyfire-pay-id': '[REDACTED]', other: 'value' };
        expect(provider.redactForLogging(params)).toBe(params);
    });
});
