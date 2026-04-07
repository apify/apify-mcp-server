import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { ErrorObject } from 'ajv';

import { FAILURE_CATEGORY, TOOL_STATUS } from '../const.js';
import type { FailureCategory, FailureDiagnostics, ToolStatus, ValidationDiagnostics } from '../types.js';
import { getHttpStatusCode } from './logging.js';

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
    if (statusCode === 401 || statusCode === 403) return FAILURE_CATEGORY.AUTH;
    if (statusCode === 404) return FAILURE_CATEGORY.INVALID_INPUT;
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) return FAILURE_CATEGORY.INVALID_INPUT;
    if (statusCode !== undefined && statusCode >= 500) return FAILURE_CATEGORY.INTERNAL_ERROR;

    return FAILURE_CATEGORY.INTERNAL_ERROR;
}

const MAX_VALIDATION_FIELD_LENGTH = 120;

function limitField(value: string | undefined): string | undefined {
    if (!value) return undefined;
    return value.length > MAX_VALIDATION_FIELD_LENGTH ? value.slice(0, MAX_VALIDATION_FIELD_LENGTH) : value;
}

export function extractValidationDiagnostics(
    errors: ErrorObject[] | null | undefined,
): ValidationDiagnostics {
    const firstError = errors?.[0];
    if (!firstError) return {};

    // Extracted fields use the first AJV error as the canonical summary:
    // - validation_keyword: AJV keyword such as "required", "additionalProperties", "minimum", "type"
    // - validation_path: AJV instancePath such as "/input/query" or "/callOptions/memory"
    // - validation_missing_property: required-property name such as "query"
    // - validation_additional_property: unexpected-property name such as "docSource"
    const diagnostics: ValidationDiagnostics = {
        validation_keyword: limitField(firstError.keyword),
        validation_path: limitField(firstError.instancePath || undefined),
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
 * Strips internal diagnostic fields from a tool response in-place and derives toolStatus + failureDiagnostics.
 *
 * Three cases:
 * 1. internalToolStatus present → use it directly.
 * 2. isError set without internalToolStatus → SOFT_FAIL (user/input problem).
 * 3. Neither → SUCCEEDED.
 *
 * Internal fields (`internalToolStatus`, `internalFailureCategory`, etc.) are deleted
 * from `res` so they are never exposed to MCP clients.
 */
export function extractToolResponseDiagnostics(
    res: Record<string, unknown>,
    actorName: string | undefined,
): { toolStatus: ToolStatus; failureDiagnostics: FailureDiagnostics } {
    const internalToolStatus = res.internalToolStatus as ToolStatus | undefined;
    const internalFailureCategory = res.internalFailureCategory as FailureCategory | undefined;
    const internalFailureHttpStatus = res.internalFailureHttpStatus as number | undefined;
    const internalValidationDiagnostics = res.internalValidationDiagnostics as FailureDiagnostics | undefined;

    delete res.internalToolStatus;
    delete res.internalFailureCategory;
    delete res.internalFailureHttpStatus;
    delete res.internalValidationDiagnostics;

    const actorField = actorName ? { actor_name: actorName } : {};
    const httpField = internalFailureHttpStatus !== undefined ? { failure_http_status: internalFailureHttpStatus } : {};

    if (internalToolStatus !== undefined) {
        return {
            toolStatus: internalToolStatus,
            failureDiagnostics: {
                ...(internalFailureCategory ? { failure_category: internalFailureCategory } : {}),
                ...httpField,
                ...actorField,
                ...internalValidationDiagnostics,
            },
        };
    }

    if (res.isError) {
        return {
            toolStatus: TOOL_STATUS.SOFT_FAIL,
            failureDiagnostics: {
                failure_category: internalFailureCategory ?? FAILURE_CATEGORY.INTERNAL_ERROR,
                ...httpField,
                ...actorField,
                ...internalValidationDiagnostics,
            },
        };
    }

    return { toolStatus: TOOL_STATUS.SUCCEEDED, failureDiagnostics: {} };
}
