import type { FailureCategory, ToolStatus, ValidationDiagnostics } from '../types.js';

/**
 * Builds usage metadata for MCP response from a source object containing Apify run costs.
 * Uses MCP-compliant key names with com.apify/ prefix as per MCP specification.
 * @param source - Object containing usage cost information
 * @param source.usageTotalUsd - Total cost in USD (optional)
 * @param source.usageUsd - Breakdown of costs by resource type (optional)
 * @returns Usage metadata object or undefined if no usage data is available
 */
export function buildUsageMeta(source: {
    usageTotalUsd?: number;
    usageUsd?: unknown;
}): Record<string, unknown> | undefined {
    const { usageTotalUsd, usageUsd } = source;
    return usageTotalUsd !== undefined
        ? {
            usageTotalUsd,
            usageUsd,
        }
        : undefined;
}

/**
 * Helper to build a response for MCP from an array of text strings.
 *
 * Status model used by this project:
 * - `isError` is MCP-visible and returned to the client.
 * - `toolStatus` is an internal helper input for server telemetry.
 * - `internalToolStatus` is the transient wire field carrying `toolStatus`
 *   from tool helpers back to the server, and is stripped before client response.
 * - `internalFailureCategory` is the transient wire field carrying `failureCategory`
 *   from tool helpers back to the server, and is stripped before client response.
 * - `internalFailureHttpStatus` is the transient wire field carrying `failureHttpStatus`
 *   from tool helpers back to the server, and is stripped before client response.
 *
 * @param options - Object containing response configuration
 * @param options.texts - Array of text strings to include in the response
 * @param options.isError - Optional flag to mark the response as an error (default: false).
 *                          This must remain MCP compliant: true for any tool-level error.
 * @param options.toolStatus - Optional internal tool status used for telemetry. When provided,
 *                             it is attached as `internalToolStatus` for server-side processing only.
 * @param options.failureCategory - Optional failure category for telemetry diagnostics. When provided,
 *                                  it is attached as `internalFailureCategory` for server-side processing only.
 * @param options.failureHttpStatus - Optional HTTP status code for telemetry diagnostics. When provided,
 *                                    it is attached as `internalFailureHttpStatus` for server-side processing only.
 * @param options.validationDiagnostics - Optional AJV validation diagnostics for telemetry. When provided,
 *                                        it is attached as `internalValidationDiagnostics` for server-side processing only.
 * @param options.structuredContent - Optional structured content of unknown type
 * @param options._meta - Optional metadata for widget rendering (e.g., OpenAI widget metadata)
 */
export function buildMCPResponse(options: {
    texts: string[];
    isError?: boolean;
    toolStatus?: ToolStatus;
    failureCategory?: FailureCategory;
    failureHttpStatus?: number;
    validationDiagnostics?: ValidationDiagnostics;
    structuredContent?: unknown;
    _meta?: Record<string, unknown>;
}) {
    const {
        texts,
        isError = false,
        toolStatus,
        failureCategory,
        failureHttpStatus,
        validationDiagnostics,
        structuredContent,
        _meta,
    } = options;

    return {
        content: texts.map((text) => ({ type: 'text' as const, text })),
        isError,
        ...(toolStatus && { internalToolStatus: toolStatus }),
        ...(failureCategory && { internalFailureCategory: failureCategory }),
        ...(failureHttpStatus !== undefined && { internalFailureHttpStatus: failureHttpStatus }),
        ...(validationDiagnostics !== undefined && { internalValidationDiagnostics: validationDiagnostics }),
        ...(structuredContent !== undefined && { structuredContent }),
        ...(_meta !== undefined && { _meta }),
    };
}
