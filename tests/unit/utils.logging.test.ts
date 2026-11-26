import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import log, { LoggerJson } from '@apify/log';

import { INVALID_REQUEST_PATH_DETAIL, InvalidRequestPathError, SchemaTooLargeError } from '../../src/errors.js';
import { MAX_UNTRUSTED_SCHEMA_BYTES } from '../../src/tools/actor_input_schema.js';
import {
    isMcpClientFaultMessage,
    logHttpError,
    sanitizeMezmoMessage,
    sanitizeMezmoValue,
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
            'Conflict: Stream already has an active connection',
            'Invalid event ID format',
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

    // The message of this error quotes the identifier the caller sent, which can be a pasted secret.
    it('logs a fixed message for an invalid identifier or request path', () => {
        const softFail = vi.spyOn(log, 'softFail').mockImplementation(() => log);

        logHttpError(new InvalidRequestPathError('Invalid Actor ID or name "Bearer secret-value"'), 'Failed to fetch');

        expect(softFail).toHaveBeenCalledWith('Failed to fetch', {
            errMessage: INVALID_REQUEST_PATH_DETAIL,
            statusCode: 400,
        });
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

    /** An error that carries the request it failed on, as an HTTP library's error can. */
    class RequestError extends Error {
        override readonly name = 'RequestError';

        constructor(
            message: string,
            readonly code: string,
            readonly config: unknown,
        ) {
            super(message);
        }
    }

    const requestConfig = { headers: { Authorization: 'Bearer test-token' } };
    const buildRequestFailure = () =>
        new RequestError('connect ECONNREFUSED 127.0.0.1:443', 'ECONNREFUSED', requestConfig);

    it('logs a request failure without its request config, which holds the token', () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

        logHttpError(buildRequestFailure(), 'Failed to get Actor run');

        const output = consoleError.mock.calls.flat().join('\n');
        expect(output).toContain('connect ECONNREFUSED');
        expect(output).not.toContain('test-token');
    });

    const loggedRequestFailure = {
        name: 'RequestError',
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
            input: 'an HTTP 5xx request failure',
            error: Object.assign(buildRequestFailure(), { statusCode: 500 }),
            field: 'exception',
            logged: loggedRequestFailure,
        },
        {
            input: 'an HTTP 5xx API error, keeping its type',
            error: Object.assign(new Error('API said no'), { statusCode: 500, type: 'some-type' }),
            field: 'exception',
            logged: { name: 'Error', message: 'API said no', stack: expect.any(String), type: 'some-type' },
        },
        {
            input: 'an MCP server error caused by a request failure',
            error: Object.assign(new McpError(ErrorCode.InternalError, 'boom'), { cause: buildRequestFailure() }),
            field: 'exception',
            logged: {
                name: 'McpError',
                message: 'MCP error -32603: boom',
                stack: expect.any(String),
                cause: loggedRequestFailure,
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

describe('sanitizeMezmoValue', () => {
    it('replaces the standalone word in every nested string and leaves other values as they are', () => {
        const input = { query: 'proxy error status code 597', limit: 5, tags: ['Error handling', 'INTERNAL_ERROR'] };

        expect(sanitizeMezmoValue(input)).toEqual({
            query: 'proxy failure status code 597',
            limit: 5,
            tags: ['failure handling', 'INTERNAL_ERROR'],
        });
    });
});
