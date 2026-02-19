import type { ActorDefinition } from 'apify-client';

import { MCP_STREAMABLE_ENDPOINT } from '../const.js';
import type { ActorDefinitionPruned } from '../types.js';
import { parseCommaSeparatedList } from '../utils/generic.js';

/**
 * Returns the MCP server path for the given Actor ID.
 * Prioritizes the streamable transport path if available.
 * The `webServerMcpPath` is a string containing MCP endpoint or endpoints separated by commas.
 */
export function getActorMCPServerPath(actorDefinition: ActorDefinition | ActorDefinitionPruned): string | null {
    if ('webServerMcpPath' in actorDefinition && typeof actorDefinition.webServerMcpPath === 'string') {
        const webServerMcpPath = actorDefinition.webServerMcpPath.trim();

        const paths = parseCommaSeparatedList(webServerMcpPath);
        // If there is only one path, return it directly
        if (paths.length === 1) {
            return paths[0];
        }

        // If there are multiple paths, prioritize the streamable transport path
        // otherwise return the first one.
        const streamablePath = paths.find((path) => path === MCP_STREAMABLE_ENDPOINT);
        if (streamablePath) {
            return streamablePath;
        }
        // Otherwise, return the first path
        return paths[0];
    }

    return null;
}

/**
 * Returns the MCP server URL for the given Actor ID.
 */
export async function getActorMCPServerURL(realActorId: string, mcpServerPath: string): Promise<string> {
    // TODO: get from API instead
    const standbyBaseUrl = process.env.HOSTNAME === 'mcp-securitybyobscurity.apify.com'
        ? 'securitybyobscurity.apify.actor' : 'apify.actor';
    const standbyUrl = await getActorStandbyURL(realActorId, standbyBaseUrl);
    return `${standbyUrl}${mcpServerPath}`;
}

/**
* Returns standby URL for given Actor ID.
*/
async function getActorStandbyURL(realActorId: string, standbyBaseUrl = 'apify.actor'): Promise<string> {
    return `https://${realActorId}.${standbyBaseUrl}`;
}
