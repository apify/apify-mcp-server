import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';

import log from '@apify/log';

import { isActorRunLimitError } from './apify_errors.js';

/**
 * Safely extract HTTP status code from errors.
 * Checks both `statusCode` and `code` properties for compatibility.
 */
export function getHttpStatusCode(error: unknown): number | undefined {
    if (typeof error !== 'object' || error === null) {
        return undefined;
    }

    // Check for statusCode property (used by apify-client)
    if ('statusCode' in error) {
        const { statusCode } = error as { statusCode?: unknown };
        if (typeof statusCode === 'number' && statusCode >= 100 && statusCode < 600) {
            return statusCode;
        }
    }

    // Check for code property (used by some error types)
    if ('code' in error) {
        const { code } = error as { code?: unknown };
        if (typeof code === 'number' && code >= 100 && code < 600) {
            return code;
        }
    }

    return undefined;
}

/**
 * Mezmo (logDNA) promotes a log entry to error level when its message contains the lowercase
 * substring "error". Replace those occurrences with "failure" so soft logs keep their level.
 * Case-sensitive: capitalized `Error`/`ERROR` does not trigger promotion, so leave it intact.
 * See CONTRIBUTING.md § Logging → Mezmo promotion rule.
 */
export function sanitizeMezmoMessage(message: string): string {
    return message.replace(/error/g, 'failure');
}

// Client faults surfaced by the MCP SDK's `onerror` — expected noise, not server bugs.
// Disconnects/transport:
//   - "No connection established" (sendRequest before transport attached)
//   - "Failed to send response: Error: Not connected" (client vanished mid-flight)
//   - "Conflict: Only one SSE stream is allowed per session" (duplicate GET, e.g. tab
//     refresh before the old SSE controller is GC'd)
//   - "Invalid state: Controller is already closed" (SSE stream closed by client before
//     a queued event was flushed)
//   - "Not Acceptable: Client must accept ... text/event-stream" (Accept header missing
//     a required MIME type; HTTP 406 already returned)
// Invalid requests from the streamable-http transport:
//   - "Parse error" (malformed JSON-RPC body)
//   - "Server not initialized" (request before initialize)
//   - "Only one initialization request" (duplicate initialize)
const MCP_CLIENT_FAULT_PATTERN = new RegExp(
    [
        'Not connected',
        'No connection established',
        'Only one SSE stream',
        'Controller is already closed',
        'Not Acceptable: Client must accept',
        'Parse error',
        'Server not initialized',
        'Only one initialization request',
    ].join('|'),
    'i',
);

/** True when an MCP SDK `onerror` message is a known client fault that should softFail, not error. */
export function isMcpClientFaultMessage(message: string): boolean {
    return MCP_CLIENT_FAULT_PATTERN.test(message);
}

/**
 * Client/caller faults and transient transport conditions that shouldn't trigger error alerts.
 * Anything else in the JSON-RPC reserved range (-32768..-32000) is treated as a server fault.
 */
const SOFT_MCP_ERROR_CODES: ReadonlySet<number> = new Set([
    ErrorCode.ParseError,
    ErrorCode.InvalidRequest,
    ErrorCode.MethodNotFound,
    ErrorCode.InvalidParams,
    ErrorCode.ConnectionClosed,
    ErrorCode.RequestTimeout,
]);

/**
 * Extract a JSON-RPC error code from an `McpError`-shaped object.
 * Returns `undefined` if the `code` field is absent or outside the JSON-RPC reserved range.
 */
function getMcpErrorCode(error: unknown): number | undefined {
    if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
    const { code } = error as { code?: unknown };
    if (typeof code === 'number' && code >= -32768 && code <= -32000) return code;
    return undefined;
}

/**
 * Logs HTTP or MCP errors at the appropriate level:
 * - Client errors (HTTP < 500, or JSON-RPC client/transient codes) → softFail (no stack).
 * - Server errors (HTTP >= 500, or JSON-RPC server codes) → exception (with stack).
 * - Anything unclassifiable → error.
 *
 * @param error - The error object
 * @param message - The log message
 * @param data - Additional data to include in the log
 */
export function logHttpError<T extends object>(error: unknown, message: string, data?: T): void {
    const statusCode = getHttpStatusCode(error);
    const rawErrorMessage = error instanceof Error ? error.message : String(error);
    const softErrMessage = sanitizeMezmoMessage(rawErrorMessage);

    // User concurrent-run / quota limit — arrives wrapped as a 500 but is a user billing condition.
    if (isActorRunLimitError(error)) {
        log.softFail(message, { errMessage: softErrMessage, ...data });
        return;
    }

    if (statusCode !== undefined && statusCode < 500) {
        // HTTP client errors (< 500) - softFail without stack trace
        log.softFail(message, { errMessage: softErrMessage, statusCode, ...data });
        return;
    }
    if (statusCode !== undefined && statusCode >= 500) {
        // HTTP server errors (>= 500) - exception with full error (includes stack trace)
        const errorObj = error instanceof Error ? error : new Error(String(error));
        log.exception(errorObj, message, { statusCode, ...data });
        return;
    }

    const mcpErrorCode = getMcpErrorCode(error);
    if (mcpErrorCode !== undefined) {
        if (SOFT_MCP_ERROR_CODES.has(mcpErrorCode)) {
            log.softFail(message, { errMessage: softErrMessage, mcpErrorCode, ...data });
        } else {
            const errorObj = error instanceof Error ? error : new Error(String(error));
            log.exception(errorObj, message, { mcpErrorCode, ...data });
        }
        return;
    }

    // No status code available - log as error
    log.error(message, { error, ...data });
}

const SKYFIRE_PAY_ID_KEY = 'skyfire-pay-id';
const REDACTED_VALUE = '[REDACTED]';

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
};

/**
 * Sanitizes tool call parameters by redacting the skyfire-pay-id.
 * Used for logging to avoid exposing the Skyfire payment token.
 *
 * @param params - The parameters object to sanitize
 * @returns A new object with skyfire-pay-id replaced with '[REDACTED]'
 */
export function redactSkyfirePayId(params: unknown): unknown {
    if (!isPlainRecord(params) || !(SKYFIRE_PAY_ID_KEY in params)) {
        return params;
    }

    if (params[SKYFIRE_PAY_ID_KEY] === REDACTED_VALUE) {
        return params;
    }

    return { ...params, [SKYFIRE_PAY_ID_KEY]: REDACTED_VALUE };
}
