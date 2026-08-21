import type { ApifyClient } from '../apify_client.js';
import { getActorMCPServerPath, getActorMCPServerURL } from '../mcp/actors.js';
import { actorDefinitionCache } from '../state.js';
import { resolveActorToolMode } from '../tools/actor_tool_naming.js';
import { getActorDefinition } from '../tools/actors/actor_definition.js';
import type { ActorDefinitionWithInfo, ActorToolResolutionResult } from '../types.js';
import { ACTOR_TOOL_MODE } from '../types.js';
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
    if (fetched) actorDefinitionCache.set(actorIdOrName, fetched);
    return fetched;
}

/**
 * Resolve how an Actor is exposed as a tool at call time, by name. The only place `resolveActorToolMode`
 * is consulted outside the tool-loading factory, so `call-actor` routing and tool loading share one rule.
 *
 * Returns `null` when there is no definition to classify (unknown Actor). The URL is a pure function of
 * the definition (`getActorMCPServerURL` does no I/O), so this rides the authorization-gated
 * `getActorDefinitionCached` instead of a separate cache that would leak a private Actor's URL across tenants.
 */
export async function getActorToolResolutionCached(
    actorIdOrName: string,
    apifyClient: ApifyClient,
): Promise<ActorToolResolutionResult | null> {
    const cached = await getActorDefinitionCached(actorIdOrName, apifyClient);
    if (!cached) return null;

    const webServerMcpPath = getActorMCPServerPath(cached.definition);
    const toolMode = resolveActorToolMode({
        definition: cached.definition,
        actor: cached.info,
        webServerMcpPath,
    });
    const { actorFullName } = cached.definition;
    // `resolveActorToolMode` returns MCP only when `webServerMcpPath` is set.
    if (toolMode === ACTOR_TOOL_MODE.MCP) {
        return {
            toolMode,
            mcpServerUrl: await getActorMCPServerURL(cached.definition.id, webServerMcpPath!),
            actorFullName,
        };
    }
    return { toolMode, mcpServerUrl: null, actorFullName };
}
