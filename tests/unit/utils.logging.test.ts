import { afterEach, describe, expect, it, vi } from 'vitest';

import log from '@apify/log';

import { SchemaTooLargeError } from '../../src/errors.js';
import { MAX_UNTRUSTED_SCHEMA_BYTES } from '../../src/tools/actor_input_schema.js';
import {
    isMcpClientFaultMessage,
    logHttpError,
    redactSkyfirePayId,
    sanitizeMezmoMessage,
} from '../../src/utils/logging.js';

describe('isMcpClientFaultMessage', () => {
    it('matches the exact MCP SDK client-fault literals', () => {
        for (const message of [
            'Bad Request: Server not initialized',
            'Invalid Request: Only one initialization request is allowed',
            'Not Acceptable: Client must accept text/event-stream',
            'Not Acceptable: Client must accept both application/json and text/event-stream',
            'Parse error: Invalid JSON',
            'Parse error: Invalid JSON-RPC message',
            'Conflict: Only one SSE stream is allowed per session',
            'Not connected',
        ]) {
            expect(isMcpClientFaultMessage(message)).toBe(true);
        }
    });

    it('matches the variable-tail disconnect messages by prefix', () => {
        expect(isMcpClientFaultMessage('No connection established for request ID: abc-123')).toBe(true);
        expect(
            isMcpClientFaultMessage('Failed to send response: Error: No connection established for request ID: 1'),
        ).toBe(true);
        expect(isMcpClientFaultMessage('Failed to send response: Error: Not connected')).toBe(true);
        expect(isMcpClientFaultMessage('Invalid state: Controller is already closed')).toBe(true);
    });

    it('does not match substrings or near-misses (avoids catching other libraries)', () => {
        expect(isMcpClientFaultMessage('Unexpected internal failure')).toBe(false);
        // A different library mentioning a fault keyword must not be swallowed.
        expect(isMcpClientFaultMessage('Database connection: Not connected to replica')).toBe(false);
        expect(isMcpClientFaultMessage('Parse error: Invalid YAML')).toBe(false);
        expect(isMcpClientFaultMessage('Server not initialized yet, retrying')).toBe(false);
    });
});

describe('sanitizeMezmoMessage', () => {
    it('replaces every "error" occurrence so Mezmo does not promote the entry', () => {
        // Mezmo promotes on the lowercase word "error"; the old ` error:` pattern missed this case.
        expect(sanitizeMezmoMessage('MCP error -32001: Request timed out')).toBe(
            'MCP failure -32001: Request timed out',
        );
    });

    it('replaces the standalone capitalized "Error" word from the SDK send-path wrap', () => {
        // The SDK wraps disconnects as `Failed to send response: Error: <message>`. The standalone
        // word "Error" is space/colon-delimited, so Mezmo promotes the entry despite the capital E.
        expect(
            sanitizeMezmoMessage('Failed to send response: Error: No connection established for request ID: 1'),
        ).toBe('Failed to send response: failure: No connection established for request ID: 1');
    });

    it('keeps "Error" embedded in identifiers intact (no word boundary, Mezmo does not promote)', () => {
        expect(sanitizeMezmoMessage('mcpErrorCode INTERNAL_ERROR')).toBe('mcpErrorCode INTERNAL_ERROR');
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

    it('soft-fails an oversized input schema (SchemaTooLargeError), not a server error', () => {
        const softFail = vi.spyOn(log, 'softFail').mockImplementation(() => log);
        const exception = vi.spyOn(log, 'exception').mockImplementation(() => log);
        const error = vi.spyOn(log, 'error').mockImplementation(() => log);

        logHttpError(new SchemaTooLargeError(MAX_UNTRUSTED_SCHEMA_BYTES), 'Failed to compile schema');

        expect(softFail).toHaveBeenCalledTimes(1);
        expect(exception).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
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
