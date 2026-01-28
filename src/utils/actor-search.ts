/**
 * Shared utility for searching and filtering actors.
 * Combines searchActorsByKeywords with filterRentalActors to prevent accidental omission
 * of the filtering step and reduce code duplication.
 */

import { ACTOR_SEARCH_ABOVE_LIMIT } from '../const.js';
import { filterRentalActors, searchActorsByKeywords } from '../tools/store_collection.js';
import type { ExtendedActorStoreList } from '../types.js';

export type SearchAndFilterActorsOptions = {
    keywords: string;
    apifyToken: string;
    limit: number;
    offset: number;
    skyfireMode?: boolean;
    userRentedActorIds?: string[];
};

/**
 * Search actors by keywords and filter rental actors.
 * This combines two operations that should always happen together to ensure consistency.
 *
 * @param options Search and filter options
 * @returns Array of filtered actors, limited to the specified limit
 */
export async function searchAndFilterActors(
    options: SearchAndFilterActorsOptions,
): Promise<ExtendedActorStoreList[]> {
    const { keywords, apifyToken, limit, offset, skyfireMode, userRentedActorIds } = options;

    const actors = await searchActorsByKeywords(
        keywords,
        apifyToken,
        limit + ACTOR_SEARCH_ABOVE_LIMIT,
        offset,
        skyfireMode ? true : undefined,
    );

    return filterRentalActors(actors || [], userRentedActorIds || []).slice(0, limit);
}
