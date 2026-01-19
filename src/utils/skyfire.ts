import { ApifyClient } from '../apify-client.js';
import { SKYFIRE_TOOL_INSTRUCTIONS } from '../const.js';
import type { ActorsMcpServer } from '../mcp/server.js';
import type { ApifyToken } from '../types.js';
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

/**
 * Creates ApifyClient with appropriate credentials based on Skyfire mode.
 * In Skyfire mode, uses skyfire-pay-id from args; otherwise uses apifyToken.
 *
 * @param apifyMcpServer - The MCP server instance with configuration options
 * @param args - Tool arguments that may contain skyfire-pay-id
 * @param apifyToken - Standard Apify token for non-Skyfire mode
 * @returns ApifyClient instance configured for the appropriate mode
 */
export function createApifyClientWithSkyfireSupport(
    apifyMcpServer: ActorsMcpServer,
    args: Record<string, unknown>,
    apifyToken: ApifyToken,
): ApifyClient {
    return apifyMcpServer.options.skyfireMode && typeof args['skyfire-pay-id'] === 'string'
        ? new ApifyClient({ skyfirePayId: args['skyfire-pay-id'] })
        : new ApifyClient({ token: apifyToken });
}
