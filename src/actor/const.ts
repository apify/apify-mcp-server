/**
 * Constants for the Actor.
 */
export const HEADER_READINESS_PROBE = 'x-apify-container-server-readiness-probe';

export enum TransportType {
    HTTP = 'HTTP',
    SSE = 'SSE',
}

export enum Routes {
    ROOT = '/',
    MCP = '/mcp',
    SSE = '/sse',
    MESSAGE = '/message',
}

export const getHelpMessage = (host: string) => `To interact with the server you can either:
- send request to ${host}${Routes.MCP}?token=YOUR-APIFY-TOKEN and receive a response
or
- connect for Server-Sent Events (SSE) via GET request to: ${host}${Routes.SSE}?token=YOUR-APIFY-TOKEN
- send messages via POST request to: ${host}${Routes.MESSAGE}?token=YOUR-APIFY-TOKEN
  (Include your message content in the request body.)`;
