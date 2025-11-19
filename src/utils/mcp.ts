/**
 * Helper to build a response for MCP from an array of text strings.
 * @param texts - Array of text strings to include in the response
 * @param isError - Optional flag to mark the response as an error (default: false)
 */
export function buildMCPResponse(texts: string[], isError = false) {
    return {
        content: texts.map((text) => ({ type: 'text', text })),
        isError,
    };
}
