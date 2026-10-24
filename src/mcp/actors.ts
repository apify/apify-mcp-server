import type { ActorDefinition } from 'apify-client';

import type { Actor, ActorDefinitionPruned } from '../types.js';
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
 * Resolves `path` against the Actor's `standbyUrl`, the platform-assigned standby origin (absent or null when
 * Actor Standby is off). The caller's Apify token goes to whatever host the URL names, so `url` is null when
 * the path leaves that origin (`@host/...`, `.host/...`, `//host/...`, `https://host/...`). Returns null when
 * the Actor has no valid standby URL: a constructed hostname would send the token to a host the platform did
 * not assign to this Actor.
 */
export function resolveOnStandbyOrigin(
    actor: Pick<Actor, 'standbyUrl'>,
    path: string,
): { standbyOrigin: string; url: URL | null } | null {
    if (!actor.standbyUrl || !URL.canParse(actor.standbyUrl)) return null;
    // Parse the standby URL first so the origin comparison is between two values normalised by the same parser.
    const standby = new URL(actor.standbyUrl);
    const url = new URL(path, standby);
    return { standbyOrigin: standby.origin, url: url.origin === standby.origin ? url : null };
}

/**
 * Returns the MCP server URL of an Actor: `mcpServerPath` resolved by `resolveOnStandbyOrigin`.
 * `mcpServerPath` comes from an Actor's `webServerMcpPath` field, i.e. it is controlled by whoever
 * published the Actor.
 */
export async function getActorMCPServerURL(
    actor: Pick<Actor, 'id' | 'standbyUrl'>,
    mcpServerPath: string,
): Promise<string> {
    const resolved = resolveOnStandbyOrigin(actor, mcpServerPath);
    if (!resolved) {
        throw new Error(
            `Actor ${actor.id} has no valid standby URL in its Actor Standby configuration, so its MCP server cannot be reached`,
        );
    }
    const { url } = resolved;
    if (!url) throw new Error(`Actor ${actor.id} declares a webServerMcpPath that resolves outside its standby origin`);
    // Strip any userinfo that survived parsing; we never want credentials in the URL we hand to the MCP client.
    url.username = '';
    url.password = '';
    return url.toString();
}
