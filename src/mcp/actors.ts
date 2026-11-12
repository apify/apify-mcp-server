import type { ActorDefinition } from 'apify-client';

import log from '@apify/log';

import { getApifyAPIBaseUrl } from '../apify_client.js';
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

/** The platform's standby domain: the platform serves Actor Standby on https subdomains of it. */
const PLATFORM_STANDBY_DOMAIN = 'apify.actor';

function isLoopbackHost(hostname: string): boolean {
    return hostname === 'localhost' || hostname.endsWith('.localhost') || ['127.0.0.1', '[::1]'].includes(hostname);
}

/**
 * Whether requests carrying the caller's token may go to `standby`: an https subdomain of the platform standby
 * domain on the default port, or, only when the configured API is itself on a loopback host (local development),
 * a loopback host. Credentials in the URL are refused.
 */
function isAllowedStandbyUrl(standby: URL): boolean {
    if (standby.username || standby.password) return false;
    if (standby.protocol === 'https:' && !standby.port && standby.hostname.endsWith(`.${PLATFORM_STANDBY_DOMAIN}`)) {
        return true;
    }
    const apiBaseUrl = getApifyAPIBaseUrl();
    return (
        ['http:', 'https:'].includes(standby.protocol) &&
        isLoopbackHost(standby.hostname) &&
        URL.canParse(apiBaseUrl) &&
        isLoopbackHost(new URL(apiBaseUrl).hostname)
    );
}

/**
 * Resolves `path` against the Actor's platform-assigned `standbyUrl` (absent when Actor Standby is off).
 *
 * `path` is publisher-controlled, and the caller's Apify token goes to whatever host the result names. A crafted
 * path (`@host/...`, `.host/...`, `//host/...`, `https://host/...`) could point the token at a third-party host,
 * so `url` is null when the path leaves the standby origin or does not parse. Returns null when the Actor has no
 * valid standby URL, or one that `isAllowedStandbyUrl` refuses; don't build a fallback hostname from the Actor
 * ID: the platform never assigned it.
 */
export function resolveOnStandbyOrigin(
    actor: Pick<Actor, 'standbyUrl'>,
    path: string,
): { standbyOrigin: string; url: URL | null } | null {
    if (!actor.standbyUrl || !URL.canParse(actor.standbyUrl)) return null;
    // Compare origins produced by the same parser; a raw-string comparison would miss case and default-port
    // differences.
    const standby = new URL(actor.standbyUrl);
    if (!isAllowedStandbyUrl(standby)) {
        log.warning('Standby URL is not on the platform standby domain; nothing is sent to it', {
            standbyOrigin: standby.origin,
        });
        return null;
    }
    const url = URL.canParse(path, standby.href) ? new URL(path, standby) : null;
    return { standbyOrigin: standby.origin, url: url?.origin === standby.origin ? url : null };
}

/** Returns the Actor's MCP server URL: `mcpServerPath` (its `webServerMcpPath`) resolved by `resolveOnStandbyOrigin`. */
export async function getActorMCPServerURL(
    actor: Pick<Actor, 'id' | 'standbyUrl'>,
    mcpServerPath: string,
): Promise<string> {
    const resolved = resolveOnStandbyOrigin(actor, mcpServerPath);
    if (!resolved) {
        const problem =
            actor.standbyUrl && URL.canParse(actor.standbyUrl)
                ? 'has a standby URL that is not on the platform standby domain'
                : 'has no valid standby URL in its Actor Standby configuration';
        throw new Error(`Actor ${actor.id} ${problem}, so its MCP server cannot be reached`);
    }
    const { url } = resolved;
    if (!url) throw new Error(`Actor ${actor.id} declares a webServerMcpPath that resolves outside its standby origin`);
    // `origin` excludes userinfo, so `https://user:pass@<standby host>/mcp` passes the origin check; drop it here.
    url.username = '';
    url.password = '';
    return url.toString();
}
