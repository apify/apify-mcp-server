import { afterEach, describe, expect, it, vi } from 'vitest';

import log from '@apify/log';

import {
    isActorRunLimitError,
    isMcpClientFaultMessage,
    logHttpError,
    redactSkyfirePayId,
    remoteMcpFailureDetail,
    sanitizeMezmoMessage,
} from '../../src/utils/logging.js';

describe('isMcpClientFaultMessage', () => {
    it('matches known client-fault messages', () => {
        for (const message of [
            'Failed to send response: Error: Not connected',
            'Conflict: Only one SSE stream is allowed per session',
            'Parse error: Invalid JSON-RPC message',
            'Bad Request: Server not initialized',
        ]) {
            expect(isMcpClientFaultMessage(message)).toBe(true);
        }
    });

    it('returns false for genuine server faults', () => {
        expect(isMcpClientFaultMessage('Unexpected internal failure')).toBe(false);
    });
});

describe('isActorRunLimitError', () => {
    it('matches an ApifyApiError-shaped error by its `type` field (direct Actor run)', () => {
        // A direct run carries the type on a field, not in the message text.
        expect(isActorRunLimitError({ type: 'cannot-start-actor-runs', message: 'Cannot start new Actor runs.' })).toBe(
            true,
        );
    });

    it('matches the type string embedded in a wrapped MCP error message', () => {
        expect(isActorRunLimitError(new Error('Streamable HTTP error: ... "type": "cannot-start-actor-runs"'))).toBe(
            true,
        );
    });

    it('returns false for unrelated errors', () => {
        expect(isActorRunLimitError(new Error('socket hang up'))).toBe(false);
        expect(isActorRunLimitError({ type: 'memory-limit-exceeded' })).toBe(false);
    });
});

describe('sanitizeMezmoMessage', () => {
    it('replaces every "error" occurrence so Mezmo does not promote the entry', () => {
        // Mezmo promotes on the lowercase word "error"; " error:" alone is not enough to catch.
        expect(sanitizeMezmoMessage('MCP error -32001: Request timed out')).toBe(
            'MCP failure -32001: Request timed out',
        );
        expect(sanitizeMezmoMessage('Parse error: Invalid JSON-RPC message')).toBe(
            'Parse failure: Invalid JSON-RPC message',
        );
    });

    it('leaves messages without "error" unchanged', () => {
        expect(sanitizeMezmoMessage('Bad Request: Server not initialized')).toBe('Bad Request: Server not initialized');
    });
});

describe('remoteMcpFailureDetail', () => {
    it('returns the billing message for the wrapped concurrent-run limit', () => {
        const detail = remoteMcpFailureDetail(
            new Error('Streamable HTTP error: ... "type": "cannot-start-actor-runs"'),
        );
        expect(detail).toContain('concurrent Actor runs');
        expect(detail).toContain('console.apify.com/billing/subscription');
    });

    it('echoes the error with the generic availability hint otherwise', () => {
        expect(remoteMcpFailureDetail(new Error('socket hang up'))).toBe(
            'socket hang up. The MCP server may be temporarily unavailable.',
        );
    });
});

describe('logHttpError', () => {
    afterEach(() => vi.restoreAllMocks());

    it('soft-fails the run-limit condition even though it arrives wrapped as a 500', () => {
        const softFail = vi.spyOn(log, 'softFail').mockImplementation(() => log);
        const exception = vi.spyOn(log, 'exception').mockImplementation(() => log);
        const error = Object.assign(new Error('Streamable HTTP error: cannot-start-actor-runs'), { statusCode: 500 });

        logHttpError(error, 'Failed to load tools from MCP server');

        expect(exception).not.toHaveBeenCalled();
        expect(softFail).toHaveBeenCalledTimes(1);
    });
});

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
