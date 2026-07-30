import { RETIRED_SELECTOR_NAMES } from '../const.js';
import { getUnauthEnabledToolCategories, unauthEnabledTools } from '../tools/index.js';
import type { ToolCategory } from '../types.js';

/**
 * Determines if an API token is required based on requested tools and actors.
 * Tool names and category membership are identical across all server modes,
 * so no mode parameter is needed.
 */
export function isApiTokenRequired(params: { toolCategoryKeys?: string[]; actorList?: string[] }): boolean {
    const { toolCategoryKeys, actorList } = params;

    // Retired selectors (add-actor, experimental, preview) are inert no-ops — strip them before
    // judging emptiness so an all-retired request is judged the same as an explicitly empty one.
    const activeToolKeys = toolCategoryKeys?.filter((key) => !RETIRED_SELECTOR_NAMES.has(key));

    // If no tools/categories specified, or only retired/no-op ones, default to requiring a token
    // (this matches the current requirement for a full server start).
    if (!activeToolKeys || activeToolKeys.length === 0) {
        return true;
    }

    const unauthTokenSet = new Set(unauthEnabledTools);
    // Convert ToolCategory[] to Set<string> for comparison with string keys
    const unauthCategorySet = new Set<string>(getUnauthEnabledToolCategories() as ToolCategory[]);

    // Safe only if the key is an unauth-enabled category or tool. Anything else — a
    // token-gated category, or an Actor name (which isn't in either set) — is unsafe.
    const areAllToolsSafe = activeToolKeys.every((key) => unauthCategorySet.has(key) || unauthTokenSet.has(key));

    const isActorsEmpty = !actorList || actorList.length === 0;

    // Only bypass token if all requested tools are public AND no specific actors requested.
    if (areAllToolsSafe && isActorsEmpty) {
        return false;
    }

    return true;
}
