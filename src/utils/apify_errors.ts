import { ApifyApiError } from 'apify-client';

import {
    APIFY_ERROR_TYPE_CANNOT_PUBLISH_ACTOR_TASK,
    APIFY_ERROR_TYPE_CANNOT_START_ACTOR_RUNS,
    APIFY_ERROR_TYPE_FULL_PERMISSION_NOT_APPROVED,
    APIFY_ERROR_TYPE_INVALID_INPUT,
    APIFY_ERROR_TYPE_MEMORY_LIMIT_EXCEEDED,
} from '../const.js';
import type { ToolInputSchema } from '../types.js';
import { wrapJsonText } from './encode_text.js';

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

/** Texts for a confirmed platform input-validation error — same shape wherever start() can throw one. */
export function buildInvalidInputTexts(actorName: string, errMsg: string, inputSchema?: ToolInputSchema): string[] {
    return [
        `Failed to call Actor '${actorName}': ${errMsg}`,
        `Please ensure the input is correct and matches the Actor's input schema.`,
        ...(inputSchema ? [`Input schema:\n${wrapJsonText(inputSchema)}`] : []),
    ];
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
