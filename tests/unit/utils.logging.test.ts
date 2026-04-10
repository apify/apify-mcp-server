import { describe, expect, it } from 'vitest';

import { redactSkyfirePayId } from '../../src/utils/logging.js';

describe('redactSkyfirePayId', () => {
    it('should pass through non-record values unchanged', () => {
        expect(redactSkyfirePayId(null)).toBeNull();
        expect(redactSkyfirePayId(undefined)).toBeUndefined();
        expect(redactSkyfirePayId('string')).toBe('string');
        expect(redactSkyfirePayId(42)).toBe(42);
        const arr = [1, 2, 3];
        expect(redactSkyfirePayId(arr)).toBe(arr);
    });

    it('should return object as-is when skyfire-pay-id is absent', () => {
        const params = { actor: 'apify/web-scraper', url: 'https://example.com' };
        expect(redactSkyfirePayId(params)).toBe(params);
    });

    it('should redact skyfire-pay-id and not mutate the original', () => {
        const params = { 'skyfire-pay-id': 'secret-token-123', actor: 'apify/web-scraper' };
        const result = redactSkyfirePayId(params);
        expect(result).toEqual({ 'skyfire-pay-id': '[REDACTED]', actor: 'apify/web-scraper' });
        expect(params['skyfire-pay-id']).toBe('secret-token-123');
    });

    it('should skip redaction if already redacted', () => {
        const params = { 'skyfire-pay-id': '[REDACTED]', other: 'value' };
        expect(redactSkyfirePayId(params)).toBe(params);
    });
});
