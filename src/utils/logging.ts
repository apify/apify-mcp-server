import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';

import log from '@apify/log';

import { SchemaTooLargeError } from '../errors.js';
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
 * Mezmo (logDNA) promotes a log entry to error level when its message contains the standalone
 * word "error" (case-insensitive), e.g. the SDK send-path wrap `Failed to send response: Error: …`.
 * Replace whole-word occurrences with "failure" so soft logs keep their level. Word-bounded, so
 * `Error`/`ERROR` embedded in identifiers (`mcpErrorCode`, `INTERNAL_ERROR`) stays intact — Mezmo
 * does not promote those. See CONTRIBUTING.md § Logging → Mezmo promotion rule.
 */
export function sanitizeMezmoMessage(message: string): string {
    return message.replace(/\berror\b/gi, 'failure');
}

// Client faults surfaced by the MCP SDK's `onerror` — expected noise, not server bugs.
// Pinned to @modelcontextprotocol/sdk@1.29.0 — server/webStandardStreamableHttp.js. The SDK calls
// onerror with a bare `new Error(message)` (no JSON-RPC code, no HTTP status — those go only into
// createJsonErrorResponse()), so the message text is the only signal here. Match exact literals to
// avoid catching unrelated libraries' errors. Re-verify these on every SDK bump (the guard test in
// utils.logging.test.ts fails loudly if a literal drifts).
const MCP_CLIENT_FAULT_MESSAGES: ReadonlySet<string> = new Set([
    'Bad Request: Server not initialized',
    'Invalid Request: Only one initialization request is allowed',
    'Not Acceptable: Client must accept text/event-stream',
    'Not Acceptable: Client must accept both application/json and text/event-stream',
    'Parse error: Invalid JSON',
    'Parse error: Invalid JSON-RPC message',
    'Conflict: Only one SSE stream is allowed per session',
    'Not connected',
]);

// Transport/runtime disconnects with variable tails — anchored at the start, not substring-anywhere.
const MCP_CLIENT_FAULT_PREFIXES: readonly string[] = [
    'No connection established for request ID:', // webStandardStreamableHttp.js sendRequest
    'Failed to send response: Error: No connection established for request ID:', // send-path wrap of the above
    'Failed to send response: Error: Not connected', // send-path wrap
    'Invalid state: Controller is already closed', // Node web-streams ERR_INVALID_STATE
];

/** True when an MCP SDK `onerror` message is a known client fault that should softFail, not error. */
export function isMcpClientFaultMessage(message: string): boolean {
    return MCP_CLIENT_FAULT_MESSAGES.has(message) || MCP_CLIENT_FAULT_PREFIXES.some((p) => message.startsWith(p));
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

    // Oversized untrusted input schema — a property of the Actor's schema, not a server fault.
    if (error instanceof SchemaTooLargeError) {
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
