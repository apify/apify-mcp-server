import type { ToolStatus } from '../types.js';

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
 * @param options - Object containing response configuration
 * @param options.texts - Array of text strings to include in the response
 * @param options.isError - Optional flag to mark the response as an error (default: false).
 *                          This must remain MCP compliant: true for any tool-level error.
 * @param options.toolStatus - Optional internal tool status used for telemetry. When provided,
 *                             it will be attached as `internalToolStatus` so the server can read it
 *                             and strip it before sending the response to the MCP client.
 * @param options.structuredContent - Optional structured content of unknown type
 * @param options._meta - Optional metadata for widget rendering (e.g., OpenAI widget metadata)
 */
export function buildMCPResponse(options: {
    texts: string[];
    isError?: boolean;
    toolStatus?: ToolStatus;
    structuredContent?: unknown;
    _meta?: Record<string, unknown>;
}) {
    const {
        texts,
        isError = false,
        toolStatus,
        structuredContent,
        _meta,
    } = options;

    return {
        content: texts.map((text) => ({ type: 'text' as const, text })),
        isError,
        ...(toolStatus && { internalToolStatus: toolStatus }),
        ...(structuredContent !== undefined && { structuredContent }),
        ...(_meta !== undefined && { _meta }),
    };
}
