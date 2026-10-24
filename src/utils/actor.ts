import type { ApifyClient } from '../apify_client.js';
import { getActorMCPServerPath } from '../mcp/actors.js';
import { actorDefinitionCache } from '../state.js';
import { getActorToolModeFromInterfaces, resolveActorInterfaces } from '../tools/actor_tool_naming.js';
import { getActorDefinition } from '../tools/actors/actor_definition.js';
import type { ActorDefinitionWithInfo, ActorInfo, ActorToolResolutionResult } from '../types.js';
import { getUserInfoCached } from './userid_cache.js';

/**
 * `actorDefinitionCache` is process-wide, so a private Actor's definition must never be served from it to
 * anyone but its owner — else another token on the same process reads it with no auth check. Two invariants
 * keep this gate from inverting into a leak:
 *   1. `info.userId` is the platform-set OWNER, not the fetching token — so a non-owner's re-fetch can't
 *      overwrite the cached ownership.
 *   2. The caller is identified by `user('me')` under their own token (the same identity the platform
 *      authorizes with) and `null` is the sole non-identity sentinel — so a hit grants no more than a bare
 *      re-fetch would. Don't drop the `!== null` guard or swap in a cheaper identity source.
 *  Trade-off: an org-owned private Actor is cached under the org's userId, so an org member
 *  calling with a personal token never matches and re-fetches every time.
 *  Fail-safe (no leak), just uncached for members - accepted over an org-membership lookup
 *   that would put a per-call API round trip back on * this path.
 */
async function callerMaySeeCachedActor(cached: ActorDefinitionWithInfo, apifyClient: ApifyClient): Promise<boolean> {
    if (cached.info.isPublic) return true;
    const { userId } = await getUserInfoCached(apifyClient.token, apifyClient);
    return userId !== null && userId === cached.info.userId;
}

/**
 * Returns the cached Actor definition + info, fetching from the platform on miss
 * and populating the cache on the way back.
 *
 * Returns `null` if the Actor does not exist (404 / 400 from the platform).
 * Non-404 errors propagate to the caller.
 */
export async function getActorDefinitionCached(
    actorIdOrName: string,
    apifyClient: ApifyClient,
): Promise<ActorDefinitionWithInfo | null> {
    const cached = actorDefinitionCache.get(actorIdOrName);
    if (cached && (await callerMaySeeCachedActor(cached, apifyClient))) return cached;
    const fetched = await getActorDefinition(actorIdOrName, apifyClient);
    // Anonymous reads can skip standby build resolution; don't cache missing interfaces for other callers (#1642).
    const isUnresolvedAnonymousServer =
        !apifyClient.token &&
        fetched?.info.actorStandby?.isEnabled === true &&
        !fetched.definition.webServerMcpPath &&
        !fetched.definition.hasWebServerSchema;
    if (fetched && !isUnresolvedAnonymousServer) actorDefinitionCache.set(actorIdOrName, fetched);
    return fetched;
}

/**
 * Resolve how an Actor is exposed as a tool at call time, by name: its interface set and the tool slot derived
 * from it. The only place `resolveActorToolMode` is consulted outside the tool-loading factory, so `call-actor`
 * routing and tool loading share one rule.
 *
 * Returns `null` when there is no definition to classify (unknown Actor). It does not resolve the MCP server URL,
 * so a bad `webServerMcpPath` fails only the MCP call that needs it (`runOnActorMcpServer`).
 */
export async function getActorToolResolutionCached(
    actorIdOrName: string,
    apifyClient: ApifyClient,
): Promise<ActorToolResolutionResult | null> {
    const cached = await getActorDefinitionCached(actorIdOrName, apifyClient);
    if (!cached) return null;

    const actorInfo: ActorInfo = {
        definition: cached.definition,
        actor: cached.info,
        webServerMcpPath: getActorMCPServerPath(cached.definition),
    };
    const interfaces = resolveActorInterfaces(actorInfo);
    return {
        toolMode: getActorToolModeFromInterfaces(interfaces),
        actorFullName: cached.definition.actorFullName,
        interfaces,
    };
}
