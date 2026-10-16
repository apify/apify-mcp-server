import type { ApifyClient } from '../apify_client.js';
import { getActorMCPServerPath, getActorMCPServerURL } from '../mcp/actors.js';
import type { PaymentProvider } from '../payments/types.js';
import { actorDefinitionCache } from '../state.js';
import { resolveActorToolMode } from '../tools/actor_tool_naming.js';
import { getActorDefinition } from '../tools/actors/actor_definition.js';
import type { ActorDefinitionWithInfo, ActorToolResolutionResult } from '../types.js';
import { ACTOR_TOOL_MODE } from '../types.js';
import { getResourceByIdOrName } from './apify_resource_id.js';
import { getUserInfoCached } from './userid_cache.js';

/** The not-found reason for a value without a username, shared by the tools that resolve one with `getActorByIdOrName`. */
export const OWN_ACTOR_NOT_FOUND_FACT =
    'A name without a username is looked up among your own Actors only; an Actor from Apify Store needs its full name as username/name (e.g., "apify/rag-web-browser").';

/** Why a name alone that matched one of the caller's own Actors found nothing: `actorFullName` has no default build. */
export function ownActorWithoutBuildFact(actorFullName: string): string {
    return `Actor '${actorFullName}' exists in your account but has no successful build yet.`;
}

/**
 * Whether `getActorByIdOrName` looks `actorIdOrName` up among the caller's own Actors: a value without a username,
 * `name` or `~name` (an ID-shaped one is tried as an ID first). Never under a payment provider: the agent pays per
 * call, and there is no Apify account whose Actors a name alone could mean.
 */
export function isOwnActorLookup(actorIdOrName: string, paymentProvider: PaymentProvider | undefined): boolean {
    if (paymentProvider) return false;
    const trimmed = actorIdOrName.trim();
    return trimmed.startsWith('~') || !(trimmed.includes('/') || trimmed.includes('~'));
}

/**
 * Looks up the Actor that `actorIdOrName` names through `fetch`: by ID, by full name, or by a name alone, which means
 * one of the caller's own Actors, in the order `getResourceByIdOrName` uses. Returns what `fetch` found and the key it
 * was found under, which for a name alone is the Actor's `username/name`, so later steps see an absolute name too.
 * `actor` is `null` when a name alone matched one of the caller's own Actors but `fetch` found nothing under its full
 * name: an Actor definition comes from the default build, which an Actor has only after a successful build.
 *
 * `fetch` never gets a `~name` key. `~name` is a different Actor for each token, while `actorDefinitionCache`, which
 * most fetches read, is process-wide (see `resolveActorId` in `tools/schedules/schedule_helpers.ts`), so `~name` is
 * read uncached through `apifyClient` and replaced by the full name. An ID or a full name goes to `fetch` unchanged,
 * at no extra request. Under a payment provider every value goes to `fetch` as given (see `isOwnActorLookup`).
 */
export async function getActorByIdOrName<T>(params: {
    actorIdOrName: string;
    apifyClient: ApifyClient;
    paymentProvider: PaymentProvider | undefined;
    fetch: (actorKey: string) => Promise<T | null>;
}): Promise<{ actorKey: string; actor: T } | { actorKey: string; actor: null } | undefined> {
    const { actorIdOrName, apifyClient, paymentProvider, fetch } = params;
    const fetchByKey = async (actorKey: string) => {
        const actor = await fetch(actorKey);
        return actor === null ? undefined : { actorKey, actor };
    };
    if (!isOwnActorLookup(actorIdOrName, paymentProvider)) return fetchByKey(actorIdOrName);
    return getResourceByIdOrName(actorIdOrName, async (safeId) => {
        if (!safeId.startsWith('~')) return fetchByKey(safeId);
        const ownActor = await apifyClient.actor(safeId).get();
        if (!ownActor) return undefined;
        const actorKey = `${ownActor.username}/${ownActor.name}`;
        return (await fetchByKey(actorKey)) ?? { actorKey, actor: null };
    });
}

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
    return { toolMode, actorFullName };
}
