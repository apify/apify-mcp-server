import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { ErrorObject } from 'ajv';

import { FAILURE_CATEGORY, HTTP_FORBIDDEN, HTTP_NOT_FOUND, HTTP_UNAUTHORIZED, TOOL_STATUS } from '../const.js';
import type { AjvErrorDetails, CallDiagnostics, FailureCategory, ToolStatus, ToolTelemetryContext } from '../types.js';
import { getHttpStatusCode } from './logging.js';
import { buildActorFields } from './tools.js';

/**
 * Central helper to classify an error into a ToolStatus value.
 *
 * - TOOL_STATUS.ABORTED   → the client explicitly aborted Request.
 * - TOOL_STATUS.SOFT_FAIL → User/client errors (HTTP 4xx, InvalidParams, validation issues).
 * - TOOL_STATUS.FAILED    → Server errors (HTTP 5xx, unknown, or unexpected exceptions).
 */
export function getToolStatusFromError(error: unknown, isAborted: boolean): ToolStatus {
    if (isAborted) {
        return TOOL_STATUS.ABORTED;
    }

    const statusCode = getHttpStatusCode(error);

    // HTTP client errors (4xx) are treated as user errors
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
        return TOOL_STATUS.SOFT_FAIL;
    }

    // MCP InvalidParams errors are also user errors
    if (error instanceof McpError && error.code === ErrorCode.InvalidParams) {
        return TOOL_STATUS.SOFT_FAIL;
    }

    // Everything else is considered a server / unexpected failure
    return TOOL_STATUS.FAILED;
}

export function classifyFailureCategory(error: unknown): FailureCategory {
    if (error instanceof McpError && error.code === ErrorCode.InvalidParams) {
        return FAILURE_CATEGORY.INVALID_INPUT;
    }

    const statusCode = getHttpStatusCode(error);
    if (statusCode === HTTP_UNAUTHORIZED || statusCode === HTTP_FORBIDDEN) return FAILURE_CATEGORY.AUTH;
    if (statusCode === HTTP_NOT_FOUND) return FAILURE_CATEGORY.INVALID_INPUT;
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) return FAILURE_CATEGORY.INVALID_INPUT;
    if (statusCode !== undefined && statusCode >= 500) return FAILURE_CATEGORY.INTERNAL_ERROR;

    return FAILURE_CATEGORY.INTERNAL_ERROR;
}

const MAX_VALIDATION_FIELD_LENGTH = 120;

function limitField(value: string | undefined): string | undefined {
    if (!value) return undefined;
    return value.length > MAX_VALIDATION_FIELD_LENGTH ? value.slice(0, MAX_VALIDATION_FIELD_LENGTH) : value;
}

export function extractAjvErrorDetails(
    errors: ErrorObject[] | null | undefined,
): AjvErrorDetails {
    if (!errors?.length) return {};

    const firstError = errors[0];

    // Extracted fields use the first AJV error as the canonical summary:
    // - validation_keyword: AJV keyword such as "required", "additionalProperties", "minimum", "type"
    // - validation_path: AJV instancePath such as "/input/query" or "/callOptions/memory"
    // - validation_missing_property: required-property name such as "query"
    // - validation_additional_property: unexpected-property name such as "docSource"
    // - validation_error_count: total number of AJV errors (signals when there's more than one)
    const diagnostics: AjvErrorDetails = {
        validation_keyword: limitField(firstError.keyword),
        validation_path: limitField(firstError.instancePath || undefined),
        validation_error_count: errors.length,
    };

    const hasParams = typeof firstError.params === 'object' && firstError.params !== null;

    if (firstError.keyword === 'required' && hasParams && 'missingProperty' in firstError.params) {
        const { missingProperty } = firstError.params as { missingProperty?: unknown };
        if (typeof missingProperty === 'string') {
            diagnostics.validation_missing_property = limitField(missingProperty);
        }
    } else if (firstError.keyword === 'additionalProperties' && hasParams && 'additionalProperty' in firstError.params) {
        const { additionalProperty } = firstError.params as { additionalProperty?: unknown };
        if (typeof additionalProperty === 'string') {
            diagnostics.validation_additional_property = limitField(additionalProperty);
        }
    }

    return diagnostics;
}

/**
 * Reads `toolTelemetry` from a tool response, strips it, and returns toolStatus + callDiagnostics.
 *
 * toolStatus resolution:
 * 1. `toolTelemetry.toolStatus` present → use it directly.
 * 2. `isError` set without toolStatus → SOFT_FAIL.
 * 3. Neither → SUCCEEDED.
 *
 * actorName/actorId are server-side context (from tool resolution).
 * Tool-reported actorId (e.g. from call-actor after resolution) takes precedence.
 */
export function extractToolTelemetry(
    res: Record<string, unknown>,
    actorName: string | undefined,
    actorId: string | undefined,
): { toolStatus: ToolStatus; callDiagnostics: CallDiagnostics } {
    const telemetry = res.toolTelemetry as ToolTelemetryContext | undefined;
    delete res.toolTelemetry;

    // Tool-reported actorId (e.g. from call-actor) takes precedence over server-side actorId
    const actorFields = buildActorFields(actorName, telemetry?.actorId ?? actorId);

    if (!telemetry) {
        if (res.isError) {
            return {
                toolStatus: TOOL_STATUS.SOFT_FAIL,
                callDiagnostics: { failure_category: FAILURE_CATEGORY.INTERNAL_ERROR, ...actorFields },
            };
        }
        return { toolStatus: TOOL_STATUS.SUCCEEDED, callDiagnostics: {} };
    }

    const toolStatus = telemetry.toolStatus
        ?? (res.isError ? TOOL_STATUS.SOFT_FAIL : TOOL_STATUS.SUCCEEDED);

    const callDiagnostics: CallDiagnostics = {
        ...(telemetry.failureCategory && { failure_category: telemetry.failureCategory }),
        ...(telemetry.failureHttpStatus !== undefined && { failure_http_status: telemetry.failureHttpStatus }),
        ...(telemetry.failureDetail && { failure_detail: telemetry.failureDetail }),
        ...actorFields,
        ...telemetry.ajvErrorDetails,
    };

    return { toolStatus, callDiagnostics };
}
