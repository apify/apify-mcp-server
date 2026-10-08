import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { AxiosError, AxiosHeaders } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import log, { LoggerJson } from '@apify/log';

import { SchemaTooLargeError } from '../../src/errors.js';
import { MAX_UNTRUSTED_SCHEMA_BYTES } from '../../src/tools/actor_input_schema.js';
import {
    isMcpClientFaultMessage,
    logHttpError,
    redactSkyfirePayId,
    sanitizeMezmoMessage,
    toPlainError,
} from '../../src/utils/logging.js';

describe('isMcpClientFaultMessage', () => {
    it('matches the exact MCP SDK client-fault literals', () => {
        for (const message of [
            'Bad Request: Server not initialized',
            'Invalid Request: Only one initialization request is allowed',
            'Invalid Request: Server already initialized',
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
        expect(
            isMcpClientFaultMessage(
                'Bad Request: Unsupported protocol version: 2025-11-25, 2025-11-25 (supported versions: 2025-11-25)',
            ),
        ).toBe(true);
    });

    it('does not match substrings or near-misses (avoids catching other libraries)', () => {
        expect(isMcpClientFaultMessage('Unexpected internal failure')).toBe(false);
        // A different library mentioning a fault keyword must not be swallowed.
        expect(isMcpClientFaultMessage('Database connection: Not connected to replica')).toBe(false);
        expect(isMcpClientFaultMessage('Parse error: Invalid YAML')).toBe(false);
        expect(isMcpClientFaultMessage('Server not initialized yet, retrying')).toBe(false);
        expect(isMcpClientFaultMessage('Unsupported protocol version in docs')).toBe(false);
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

    it('soft-fails Zod validation failures from untrusted MCP tools/list payloads', () => {
        const softFail = vi.spyOn(log, 'softFail').mockImplementation(() => log);
        const exception = vi.spyOn(log, 'exception').mockImplementation(() => log);
        const error = vi.spyOn(log, 'error').mockImplementation(() => log);

        logHttpError(new ZodError([]), `Failed to list MCP tools for Actor 'red.cars/example'`);

        expect(softFail).toHaveBeenCalledTimes(1);
        expect(exception).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
    });

    it('soft-fails Zod-shaped errors even when name is $ZodError (SDK / Zod 4)', () => {
        const softFail = vi.spyOn(log, 'softFail').mockImplementation(() => log);
        const errorLog = vi.spyOn(log, 'error').mockImplementation(() => log);
        const zodShaped = Object.assign(new Error('Invalid input'), { name: '$ZodError', issues: [] });

        logHttpError(zodShaped, `Failed to list MCP tools for Actor 'red.cars/example'`);

        expect(softFail).toHaveBeenCalledTimes(1);
        expect(errorLog).not.toHaveBeenCalled();
    });

    it('soft-fails remote transport failures (socket hang up) even when wrapped as HTTP 500', () => {
        const softFail = vi.spyOn(log, 'softFail').mockImplementation(() => log);
        const exception = vi.spyOn(log, 'exception').mockImplementation(() => log);
        const error = Object.assign(
            new Error('Streamable HTTP error: Error POSTing to endpoint: Error: socket hang up'),
            { statusCode: 500 },
        );

        logHttpError(error, 'Failed to load tools from MCP server');

        expect(exception).not.toHaveBeenCalled();
        expect(softFail).toHaveBeenCalledTimes(1);
    });

    it('soft-fails gateway timeouts from upstream docs or Actor MCP', () => {
        const softFail = vi.spyOn(log, 'softFail').mockImplementation(() => log);
        const exception = vi.spyOn(log, 'exception').mockImplementation(() => log);
        const error = Object.assign(new Error('HTTP 504 Gateway Time-out'), { statusCode: 504 });

        logHttpError(error, 'Failed to fetch the documentation page');

        expect(exception).not.toHaveBeenCalled();
        expect(softFail).toHaveBeenCalledTimes(1);
    });

    it('still exceptions genuine upstream 500s that are not transport noise', () => {
        const softFail = vi.spyOn(log, 'softFail').mockImplementation(() => log);
        const exception = vi.spyOn(log, 'exception').mockImplementation(() => log);
        const error = Object.assign(new Error('Internal server failure in Apify API'), { statusCode: 500 });

        logHttpError(error, 'Failed to get Actor run');

        expect(softFail).not.toHaveBeenCalled();
        expect(exception).toHaveBeenCalledTimes(1);
    });

    it('logs an axios failure without its request config, which holds the token', () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const config = { headers: new AxiosHeaders({ Authorization: 'Bearer test-token' }) };

        logHttpError(
            new AxiosError('connect ECONNREFUSED 127.0.0.1:443', 'ECONNREFUSED', config),
            'Failed to get Actor run',
        );

        const output = consoleError.mock.calls.flat().join('\n');
        expect(output).toContain('connect ECONNREFUSED');
        expect(output).not.toContain('test-token');
    });

    const requestConfig = { headers: new AxiosHeaders({ Authorization: 'Bearer test-token' }) };
    const buildAxiosFailure = () => new AxiosError('connect ECONNREFUSED 127.0.0.1:443', 'ECONNREFUSED', requestConfig);
    const loggedAxiosFailure = {
        name: 'AxiosError',
        message: 'connect ECONNREFUSED 127.0.0.1:443',
        stack: expect.any(String),
        code: 'ECONNREFUSED',
    };

    // The text format prints an exception's stack, `type` and cause, but not its `name` or `code`.
    function logHttpErrorAsJson(error: unknown): Record<string, unknown> {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const { logger } = log.getOptions();
        log.setOptions({ logger: new LoggerJson() });
        try {
            logHttpError(error, 'Failed to get Actor run');
        } finally {
            log.setOptions({ logger });
        }
        return JSON.parse(consoleError.mock.calls[0][0]);
    }

    it.each([
        {
            input: 'an HTTP 5xx axios failure',
            error: Object.assign(buildAxiosFailure(), { statusCode: 500 }),
            field: 'exception',
            logged: loggedAxiosFailure,
        },
        {
            input: 'an HTTP 5xx API error, keeping its type',
            error: Object.assign(new Error('API said no'), { statusCode: 500, type: 'some-type' }),
            field: 'exception',
            logged: { name: 'Error', message: 'API said no', stack: expect.any(String), type: 'some-type' },
        },
        {
            input: 'an MCP server error caused by an axios failure',
            error: Object.assign(new McpError(ErrorCode.InternalError, 'boom'), { cause: buildAxiosFailure() }),
            field: 'exception',
            logged: {
                name: 'McpError',
                message: 'MCP error -32603: boom',
                stack: expect.any(String),
                cause: loggedAxiosFailure,
            },
        },
        {
            input: 'an HTTP 5xx error with an object cause',
            error: Object.assign(new Error('outer', { cause: { config: requestConfig } }), { statusCode: 500 }),
            field: 'exception',
            logged: { name: 'Error', message: 'outer', stack: expect.any(String) },
        },
        { input: 'a string', error: 'a string', field: 'error', logged: { name: 'Error', message: 'a string' } },
        {
            input: 'a plain object',
            error: { message: 'object message', config: requestConfig },
            field: 'error',
            logged: { name: 'Error', message: '[object Object]' },
        },
    ])('keeps the request config out when logging $input', ({ error, field, logged }) => {
        const line = logHttpErrorAsJson(error);

        expect(JSON.stringify(line)).not.toContain('test-token');
        expect(line[field]).toEqual(logged);
    });

    it.each([
        { cause: 'a string cause', logged: 'a string cause' },
        { cause: 42, logged: '42' },
        { cause: false, logged: 'false' },
    ])('logs the primitive cause $cause as text', ({ cause, logged }) => {
        const line = logHttpErrorAsJson(Object.assign(new Error('outer', { cause }), { statusCode: 500 }));

        expect(line.exception).toEqual({ name: 'Error', message: 'outer', stack: expect.any(String), cause: logged });
    });

    it.each([
        {
            input: 'a cyclic cause chain',
            buildError: () => {
                const error = new Error('cyclic');
                error.cause = error;
                return error;
            },
        },
        { input: 'a null-prototype cause', buildError: () => new Error('outer', { cause: Object.create(null) }) },
    ])('logs an error with $input without throwing', ({ buildError }) => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

        expect(() => logHttpError(buildError(), 'Failed to get Actor run')).not.toThrow();
        expect(consoleError).toHaveBeenCalledTimes(1);
    });
});

describe('toPlainError', () => {
    it('copies at most three causes of an error', () => {
        let error = new Error('level 4');
        for (let level = 3; level >= 0; level--) {
            error = new Error(`level ${level}`, { cause: error });
        }

        const messages: string[] = [];
        for (let copy: unknown = toPlainError(error); copy instanceof Error; copy = copy.cause) {
            messages.push(copy.message);
        }

        expect(messages).toEqual(['level 0', 'level 1', 'level 2', 'level 3']);
    });
});

describe('redactSkyfirePayId', () => {
    it('passes through non-record values unchanged', () => {
        expect(redactSkyfirePayId(null)).toBeNull();
        expect(redactSkyfirePayId(undefined)).toBeUndefined();
        expect(redactSkyfirePayId('string')).toBe('string');
        expect(redactSkyfirePayId(42)).toBe(42);
        const arr = [1, 2, 3];
        expect(redactSkyfirePayId(arr)).toBe(arr);
    });

    it('returns object as-is when skyfire-pay-id is absent', () => {
        const params = { actor: 'apify/web-scraper', url: 'https://example.com' };
        expect(redactSkyfirePayId(params)).toBe(params);
    });

    it('redacts skyfire-pay-id without mutating the original', () => {
        const params = { 'skyfire-pay-id': 'secret-token-123', actor: 'apify/web-scraper' };
        const result = redactSkyfirePayId(params);
        expect(result).toEqual({ 'skyfire-pay-id': '[REDACTED]', actor: 'apify/web-scraper' });
        expect(params['skyfire-pay-id']).toBe('secret-token-123');
    });

    it('skips redaction if already redacted', () => {
        const params = { 'skyfire-pay-id': '[REDACTED]', other: 'value' };
        expect(redactSkyfirePayId(params)).toBe(params);
    });
});
