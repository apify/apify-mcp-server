import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { ApifyApiError } from 'apify-client';

import {
    APIFY_ERROR_TYPE_CANNOT_PUBLISH_ACTOR_TASK,
    APIFY_ERROR_TYPE_CANNOT_START_ACTOR_RUNS,
    APIFY_ERROR_TYPE_CONCURRENT_RUNS_LIMIT_EXCEEDED,
    APIFY_ERROR_TYPE_FULL_PERMISSION_NOT_APPROVED,
    APIFY_ERROR_TYPE_INVALID_INPUT,
    APIFY_ERROR_TYPE_MEMORY_LIMIT_EXCEEDED,
} from '../const.js';

// Helpers that read or classify an error received from the Apify API by its `type`. Kept in one leaf
// module (imports only const and external packages) so logging, telemetry, payments, and the tool layer
// can share them without import cycles.

/** The API's machine-readable error type (e.g. `actor-task-name-not-unique`), if the error carries one. */
export function getApifyErrorType(error: unknown): string | undefined {
    return error instanceof ApifyApiError ? error.type : undefined;
}

/** True when an Actor requires full-permission approval the user has not granted. */
export function isPermissionApprovalError(error: unknown): error is ApifyApiError {
    return error instanceof ApifyApiError && error.type === APIFY_ERROR_TYPE_FULL_PERMISSION_NOT_APPROVED;
}

/** True when an Actor run is rejected because the account memory quota is exceeded. */
export function isMemoryQuotaError(error: unknown): error is ApifyApiError {
    return error instanceof ApifyApiError && error.type === APIFY_ERROR_TYPE_MEMORY_LIMIT_EXCEEDED;
}

/** True when the API rejects a supplied `publicConfig` field or a request to publish the task. */
export function isCannotPublishTaskError(error: unknown): error is ApifyApiError {
    return error instanceof ApifyApiError && error.type === APIFY_ERROR_TYPE_CANNOT_PUBLISH_ACTOR_TASK;
}

/**
 * True when the platform rejected `actor.start()` because the input fails the Actor's real
 * schema — a stricter, server-side check than our own AJV gate's derived/shortened copy.
 */
export function isActorInputValidationError(error: unknown): error is ApifyApiError {
    return error instanceof ApifyApiError && error.type === APIFY_ERROR_TYPE_INVALID_INPUT;
}

/**
 * The Apify platform refuses to start a run when the user hits their concurrent-run / usage limit.
 * A direct Actor run surfaces it as an `ApifyApiError` whose `type` is `concurrent-runs-limit-exceeded`
 * (HTTP 402). The Actor Standby controller wraps a failed run start as `cannot-start-actor-runs`
 * (HTTP 500); a remote MCP-server Actor passes that on as a plain Error whose message carries the type.
 * Either way it's a user billing condition, not a server fault — hence the duck-typed `type` check
 * plus a message-substring fallback for the wrapped case.
 */
export function isActorRunLimitError(error: unknown): boolean {
    if (
        typeof error === 'object' &&
        error !== null &&
        [APIFY_ERROR_TYPE_CONCURRENT_RUNS_LIMIT_EXCEEDED, APIFY_ERROR_TYPE_CANNOT_START_ACTOR_RUNS].some(
            (type) => (error as { type?: unknown }).type === type,
        )
    ) {
        return true;
    }
    const message = error instanceof Error ? error.message : String(error);
    return message.includes(APIFY_ERROR_TYPE_CANNOT_START_ACTOR_RUNS);
}

/** User-facing message shown when an Actor run is rejected for hitting the concurrent-run limit. */
export const ACTOR_RUN_LIMIT_MESSAGE =
    'You have reached your account limit for concurrent Actor runs. ' +
    'Wait for running Actors to finish, or upgrade your plan at https://console.apify.com/billing/subscription.';

/**
 * True when the MCP server may not have answered: the connection closed, the request timed out, the network failed,
 * or the transport got a 5xx. Node system errors carry a string code (ECONNRESET); fetch reports one as the cause
 * of a TypeError; the SDK transports put the HTTP status in `code` (protocol error codes are negative).
 */
function isMcpServerUnavailableError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;
    const { code, cause } = error as { code?: unknown; cause?: unknown };
    if (code === ErrorCode.ConnectionClosed || code === ErrorCode.RequestTimeout) return true;
    if (typeof code === 'number' && code >= 500) return true;
    return typeof code === 'string' || (error instanceof TypeError && cause !== undefined);
}

/** User-facing detail appended to a failed remote MCP-server tool call message. */
export function remoteMcpFailureDetail(error: unknown): string {
    if (isActorRunLimitError(error)) return ACTOR_RUN_LIMIT_MESSAGE;
    const message = error instanceof Error ? error.message : String(error);
    if (!isMcpServerUnavailableError(error)) return `${message}.`;
    return `${message}. The MCP server may be temporarily unavailable.`;
}
