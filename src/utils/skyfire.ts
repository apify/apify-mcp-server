import { SKYFIRE_TOOL_INSTRUCTIONS } from '../const.js';
import type { ActorsMcpServer } from '../mcp/server.js';
import { buildMCPResponse } from './mcp.js';

/**
 * Checks if Skyfire mode is enabled and skyfire-pay-id is missing.
 * Returns error response if validation fails, otherwise returns null.
 *
 * @param apifyMcpServer - The MCP server instance with configuration options
 * @param args - Tool arguments that may contain skyfire-pay-id
 * @returns MCP error response if validation fails, null if validation passes
 */
export function validateSkyfirePayId(
    apifyMcpServer: ActorsMcpServer,
    args: Record<string, unknown>,
): ReturnType<typeof buildMCPResponse> | null {
    if (apifyMcpServer.options.skyfireMode && args['skyfire-pay-id'] === undefined) {
        return buildMCPResponse({
            texts: [SKYFIRE_TOOL_INSTRUCTIONS],
        });
    }
    return null;
}
