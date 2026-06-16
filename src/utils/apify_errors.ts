import { ApifyApiError } from 'apify-client';

import {
    APIFY_ERROR_TYPE_CANNOT_START_ACTOR_RUNS,
    APIFY_ERROR_TYPE_FULL_PERMISSION_NOT_APPROVED,
    APIFY_ERROR_TYPE_MEMORY_LIMIT_EXCEEDED,
} from '../const.js';

// Predicates that classify an error received from the Apify API by its `type`. Kept in one leaf
// module (imports only const + apify-client) so logging, telemetry, payments, and the tool layer
// can share them without import cycles.

/** True when an Actor requires full-permission approval the user has not granted. */
export function isPermissionApprovalError(error: unknown): error is ApifyApiError {
    return error instanceof ApifyApiError && error.type === APIFY_ERROR_TYPE_FULL_PERMISSION_NOT_APPROVED;
}

/** True when an Actor run is rejected because the account memory quota is exceeded. */
export function isMemoryQuotaError(error: unknown): error is ApifyApiError {
    return error instanceof ApifyApiError && error.type === APIFY_ERROR_TYPE_MEMORY_LIMIT_EXCEEDED;
}

/**
 * The Apify platform refuses to start a run when the user hits their concurrent-run / usage limit.
 * A direct Actor run surfaces it as an `ApifyApiError` whose `type` is `cannot-start-actor-runs`;
 * a remote MCP-server Actor wraps it as an HTTP 500 whose body carries that same type string.
 * Either way it's a user billing condition, not a server fault — hence the duck-typed `type` check
 * plus a message-substring fallback (the wrapped case is a plain Error, not an `ApifyApiError`).
 */
export function isActorRunLimitError(error: unknown): boolean {
    if (
        typeof error === 'object' &&
        error !== null &&
        (error as { type?: unknown }).type === APIFY_ERROR_TYPE_CANNOT_START_ACTOR_RUNS
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

/** User-facing detail appended to a failed remote MCP-server tool call message. */
export function remoteMcpFailureDetail(error: unknown): string {
    if (isActorRunLimitError(error)) return ACTOR_RUN_LIMIT_MESSAGE;
    const message = error instanceof Error ? error.message : String(error);
    return `${message}. The MCP server may be temporarily unavailable.`;
}
