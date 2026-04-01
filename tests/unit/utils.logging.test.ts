import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSoftFail = vi.fn();
const mockException = vi.fn();
const mockError = vi.fn();

vi.mock('@apify/log', () => ({
    default: {
        softFail: (...args: unknown[]) => mockSoftFail(...args),
        exception: (...args: unknown[]) => mockException(...args),
        error: (...args: unknown[]) => mockError(...args),
    },
}));

// eslint-disable-next-line import/first -- @apify/log mock must run before loading the module under test
import {
    logHttpError,
    redactSkyfirePayId,
} from '../../src/utils/logging.js';

describe('logHttpError', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should softFail for 401', () => {
        const err = Object.assign(new Error('Unauthorized'), { statusCode: 401 });
        logHttpError(err, 'upstream failed', { toolName: 'x' });
        expect(mockSoftFail).toHaveBeenCalledWith('upstream failed', {
            errMessage: 'Unauthorized',
            statusCode: 401,
            toolName: 'x',
        });
    });

    it('should softFail for 403', () => {
        const err = Object.assign(new Error('Forbidden'), { statusCode: 403 });
        logHttpError(err, 'denied');
        expect(mockSoftFail).toHaveBeenCalledWith('denied', {
            errMessage: 'Forbidden',
            statusCode: 403,
        });
    });

    it('should softFail for 404', () => {
        const err = Object.assign(new Error('Nope'), { statusCode: 404 });
        logHttpError(err, 'missing');
        expect(mockSoftFail).toHaveBeenCalledWith('missing', {
            errMessage: 'Nope',
            statusCode: 404,
        });
    });

    it('should log exception for 500', () => {
        const err = Object.assign(new Error('Boom'), { statusCode: 500 });
        logHttpError(err, 'server error');
        expect(mockException).toHaveBeenCalledWith(err, 'server error', { statusCode: 500 });
    });

    it('should log error when no status code', () => {
        const err = new Error('Unknown');
        logHttpError(err, 'no status');
        expect(mockError).toHaveBeenCalledWith('no status', { error: err });
    });
});

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
