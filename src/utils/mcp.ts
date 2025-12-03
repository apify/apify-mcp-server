/**
 * Helper to build a response for MCP from an array of text strings.
 * @param options - Object containing response configuration
 * @param options.texts - Array of text strings to include in the response
 * @param options.isError - Optional flag to mark the response as an error (default: false)
 * @param options.structuredContent - Optional structured content of unknown type
 */
export function buildMCPResponse(options: { texts: string[]; isError?: boolean; structuredContent?: unknown }) {
    const { texts, isError = false, structuredContent } = options;
    return {
        content: texts.map((text) => ({ type: 'text', text })),
        isError,
        structuredContent,
    };
}
