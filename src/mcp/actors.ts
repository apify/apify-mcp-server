import type { ActorDefinition } from 'apify-client';

import type { Actor, ActorDefinitionPruned } from '../types.js';
import { parseCommaSeparatedList } from '../utils/generic.js';
import { MCP_STREAMABLE_ENDPOINT } from './const.js';

/**
 * Returns the MCP endpoint path an Actor declares in `webServerMcpPath`, or null when it declares none.
 *
 * Actors may list several comma-separated endpoints, typically a legacy SSE one next to `/mcp`.
 * Only an exact `/mcp` match is preferred; any other spelling falls back to the first listed path.
 */
export function getActorMCPServerPath(actorDefinition: ActorDefinition | ActorDefinitionPruned): string | null {
    if ('webServerMcpPath' in actorDefinition && typeof actorDefinition.webServerMcpPath === 'string') {
        const webServerMcpPath = actorDefinition.webServerMcpPath.trim();

        const paths = parseCommaSeparatedList(webServerMcpPath);
        if (paths.length === 1) {
            return paths[0];
        }

        const streamablePath = paths.find((path) => path === MCP_STREAMABLE_ENDPOINT);
        if (streamablePath) {
            return streamablePath;
        }
        return paths[0];
    }

    return null;
}

/**
 * Returns the Actor's MCP server URL: `mcpServerPath` resolved against its platform-assigned `standbyUrl`.
 *
 * `mcpServerPath` is publisher-controlled, and the client sends the caller's Apify token to the result.
 * A crafted path (`@host/...`, `.host/...`, `//host/...`, `https://host/...`) could point that token at a
 * third-party host, so any path resolving outside the standby origin is rejected.
 */
export async function getActorMCPServerURL(
    actor: Pick<Actor, 'id' | 'standbyUrl'>,
    mcpServerPath: string,
): Promise<string> {
    // `standbyUrl` is absent when Actor Standby is off. Don't build a fallback hostname from the Actor ID:
    // the platform never assigned it, so it is not a host we can trust with the token.
    if (!actor.standbyUrl || !URL.canParse(actor.standbyUrl)) {
        throw new Error(
            `Actor ${actor.id} has no valid standby URL in its Actor Standby configuration, so its MCP server cannot be reached`,
        );
    }
    // Compare origins produced by the same parser; a raw-string comparison would miss case and default-port
    // differences.
    const standby = new URL(actor.standbyUrl);

    const resolved = new URL(mcpServerPath, standby);
    if (resolved.origin !== standby.origin) {
        throw new Error(`Actor ${actor.id} declares a webServerMcpPath that resolves outside its standby origin`);
    }
    // `origin` excludes userinfo, so `https://user:pass@<standby host>/mcp` passes the check above; drop it here.
    resolved.username = '';
    resolved.password = '';
    return resolved.toString();
}
