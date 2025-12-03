import type { ToolStatus } from '../types.js';

/**
 * Helper to build a response for MCP from an array of text strings.
 * @param texts - Array of text strings to include in the response
 * @param isError - Optional flag to mark the response as an error (default: false).
 *                  This must remain MCP compliant: true for any tool-level error.
 * @param toolStatus - Optional internal tool status used for telemetry. When provided,
 *                     it will be attached as `_toolStatus` so the server can read it
 *                     and strip it before sending the response to the MCP client.
 */
export function buildMCPResponse(
    texts: string[],
    isError = false,
    toolStatus?: ToolStatus,
) {
    return {
        content: texts.map((text) => ({ type: 'text', text })),
        isError,
        ...(toolStatus && { _toolStatus: toolStatus }),
    };
}
