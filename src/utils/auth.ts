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

    // If no tools or categories specified, default to requiring token
    // (This matches current requirement for full server start)
    if (!toolCategoryKeys || toolCategoryKeys.length === 0) {
        return true;
    }

    // Retired selectors are inert — they never load a token-gated tool, so ignore them when
    // judging safety. A request for only retired selectors therefore needs no token.
    const activeToolKeys = toolCategoryKeys.filter((key) => !RETIRED_SELECTOR_NAMES.has(key));

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
