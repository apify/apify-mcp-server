import type { ToolStatus } from '../types.js';

/**
 * Helper to build a response for MCP from an array of text strings.
 * @param options - Object containing response configuration
 * @param options.texts - Array of text strings to include in the response
 * @param options.isError - Optional flag to mark the response as an error (default: false).
 *                          This must remain MCP compliant: true for any tool-level error.
 * @param options.toolStatus - Optional internal tool status used for telemetry. When provided,
 *                             it will be attached as `_toolStatus` so the server can read it
 *                             and strip it before sending the response to the MCP client.
 * @param options.structuredContent - Optional structured content of unknown type
 */

export function buildMCPResponse(options: {
    texts: string[];
    isError?: boolean;
    toolStatus?: ToolStatus;
    structuredContent?: unknown;
}) {
    const {
        texts,
        isError = false,
        toolStatus,
        structuredContent,
    } = options;

    const response: {
        content: { type: 'text'; text: string }[];
        isError: boolean;
        internalToolStatus?: ToolStatus;
        structuredContent?: unknown;
    } = {
        content: texts.map((text) => ({ type: 'text', text })),
        isError,
    };

    // Attach internal tool status for telemetry; server will read and strip it
    if (toolStatus) {
        response.internalToolStatus = toolStatus;
    }

    // Add structured content if provided
    if (structuredContent !== undefined) {
        response.structuredContent = structuredContent;
    }

    return response;
}
