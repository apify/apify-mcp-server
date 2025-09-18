import type { ApifyClient } from '../apify-client.js';
import { getActorMCPServerPath, getActorMCPServerURL } from '../mcp/actors.js';
import { mcpServerCache } from '../state.js';
import { getActorDefinition } from '../tools/build.js';
import type { ActorDefinitionStorage, DatasetItem } from '../types.js';
import { getValuesByDotKeys } from './generic.js';

/**
 * Resolve and cache the MCP server URL for the given Actor.
 * - Returns a string URL when the Actor exposes an MCP server
 * - Returns false when the Actor is not an MCP server
 * Uses a TTL LRU cache to avoid repeated API calls.
 */
export async function getActorMcpUrlCached(
    actorIdOrName: string,
    apifyClient: ApifyClient,
): Promise<string | false> {
    const cached = mcpServerCache.get(actorIdOrName);
    if (cached !== null && cached !== undefined) {
        return cached as string | false;
    }

    const actorDefinitionPruned = await getActorDefinition(actorIdOrName, apifyClient);
    const mcpPath = actorDefinitionPruned && getActorMCPServerPath(actorDefinitionPruned);
    if (actorDefinitionPruned && mcpPath) {
        const url = await getActorMCPServerURL(actorDefinitionPruned.id, mcpPath);
        mcpServerCache.set(actorIdOrName, url);
        return url;
    }

    mcpServerCache.set(actorIdOrName, false);
    return false;
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
export function ensureOutputWithinCharLimit(items: DatasetItem[], importantFields: string[], charLimit: number): DatasetItem[] {
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
    // Try only the important fields
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
