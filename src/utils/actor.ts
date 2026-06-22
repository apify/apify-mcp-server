import type { ApifyClient } from '../apify_client.js';
import { getActorMCPServerPath, getActorMCPServerURL } from '../mcp/actors.js';
import { actorDefinitionCache } from '../state.js';
import { getActorDefinition } from '../tools/build.js';
import type { ActorDefinitionStorage, ActorDefinitionWithInfo, DatasetItem } from '../types.js';
import { getValuesByDotKeys } from './generic.js';
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
 * Resolve the Actor's MCP server URL, or `false` if it isn't an MCP server. The URL is a pure function of
 * the definition (`getActorMCPServerURL` does no I/O), so this rides the authorization-gated
 * `getActorDefinitionCached` instead of a separate cache that would leak a private Actor's URL across tenants.
 */
export async function getActorMcpUrlCached(actorIdOrName: string, apifyClient: ApifyClient): Promise<string | false> {
    const definition = (await getActorDefinitionCached(actorIdOrName, apifyClient))?.definition;
    const mcpPath = definition && getActorMCPServerPath(definition);
    if (!mcpPath) return false;
    return getActorMCPServerURL(definition.id, mcpPath);
}

/**
 * Returns an array of all field names mentioned in the display.properties
 * of all views in the given ActorDefinitionStorage object.
 */
export function getActorDefinitionStorageFieldNames(storage: ActorDefinitionStorage | object): string[] {
    const fieldSet = new Set<string>();
    if ('views' in storage && typeof storage.views === 'object' && storage.views !== null) {
        for (const view of Object.values(storage.views)) {
            // Collect from display.properties
            if (view.display && view.display.properties) {
                Object.keys(view.display.properties).forEach((field) => fieldSet.add(field));
            }
            // Collect from transformation.fields
            if (view.transformation && Array.isArray(view.transformation.fields)) {
                view.transformation.fields.forEach((field) => {
                    if (typeof field === 'string') fieldSet.add(field);
                });
            }
        }
    }
    return Array.from(fieldSet);
}

/**
 * Ensures the Actor output items are within the character limit.
 *
 * First checks if all items fit into the limit, then tries only the important fields and as a last resort
 * starts removing items until within the limit. In worst scenario return empty array.
 *
 * This is primarily used to ensure the tool output does not exceed the LLM context length or tool output limit.
 */
export function ensureOutputWithinCharLimit(
    items: DatasetItem[],
    importantFields: string[],
    charLimit: number,
): DatasetItem[] {
    // Check if all items fit into the limit
    const allItemsString = JSON.stringify(items);
    if (allItemsString.length <= charLimit) {
        return items;
    }

    /**
     * Items used for the final fallback - removing items until within the limit.
     * If important fields are defined, use only those fields for that fallback step.
     */
    let sourceItems = items;
    // Try keeping only the important fields
    if (importantFields.length > 0) {
        const importantItems = items.map((item) => getValuesByDotKeys(item, importantFields));
        const importantItemsString = JSON.stringify(importantItems);
        if (importantItemsString.length <= charLimit) {
            return importantItems;
        }
        sourceItems = importantItems;
    }

    // Start removing items until within the limit
    const result: DatasetItem[] = [];
    for (const item of sourceItems) {
        if (JSON.stringify(result.concat(item)).length > charLimit) {
            break;
        }
        result.push(item);
    }
    return result;
}
