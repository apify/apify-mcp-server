/**
 * Helper to build a response for MCP from an array of text strings.
 */
export function buildMCPResponse(texts: string[]) {
    return {
        content: texts.map((text) => ({ type: 'text', text })),
    };
}
