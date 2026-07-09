import type { ActorDefinition } from 'apify-client';

import { ApifyClient } from '../apify_client.js';
import type { ActorDefinitionPruned } from '../types.js';
import { parseCommaSeparatedList } from '../utils/generic.js';
import { MCP_STREAMABLE_ENDPOINT } from './const.js';

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
 *
 * `mcpServerPath` comes from an Actor's `webServerMcpPath` field, i.e. it is
 * controlled by whoever published the Actor. Resolve it against the standby
 * origin and reject anything that escapes that origin so a crafted path
 * (`@host/...`, `.host/...`, `//host/...`, `https://host/...`) cannot redirect
 * the MCP client — and the caller's Apify token — to a third-party host.
 */
export async function getActorMCPServerURL(realActorId: string, mcpServerPath: string): Promise<string> {
    // TODO: get from API instead
    const standbyBaseUrl =
        process.env.HOSTNAME === 'mcp-securitybyobscurity.apify.com'
            ? 'securitybyobscurity.apify.actor'
            : 'apify.actor';
    // Parse the standby URL up front so the origin comparison below is between two
    // values normalised by the same parser — WHATWG lowercases hostnames, and Apify
    // Actor IDs are mixed-case, so a raw-string comparison would reject legitimate URLs.
    const standby = new URL(`https://${realActorId}.${standbyBaseUrl}/`);

    const resolved = new URL(mcpServerPath, standby);
    if (resolved.origin !== standby.origin) {
        throw new Error(`Actor ${realActorId} declares a webServerMcpPath that resolves outside its standby origin`);
    }
    // Strip any userinfo that survived parsing; we never want credentials in the URL we hand to the MCP client.
    resolved.username = '';
    resolved.password = '';
    return resolved.toString();
}

/**
 * Gets Actor ID from the Actor object.
 */
export async function getRealActorID(actorIdOrName: string, apifyToken: string): Promise<string> {
    const apifyClient = new ApifyClient({ token: apifyToken });

    const actor = apifyClient.actor(actorIdOrName);
    const info = await actor.get();
    if (!info) {
        throw new Error(`Actor ${actorIdOrName} not found`);
    }
    return info.id;
}
