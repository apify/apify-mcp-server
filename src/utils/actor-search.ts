/**
 * Shared utility for searching and filtering actors.
 * Combines searchActorsByKeywords with filterRentalActors to prevent accidental omission
 * of the filtering step and reduce code duplication.
 */

import { ApifyClient } from '../apify-client.js';
import { ACTOR_SEARCH_ABOVE_LIMIT } from '../const.js';
import { filterRentalActors } from '../tools/store_collection.js';
import type { ExtendedActorStoreList } from '../types.js';

export type SearchAndFilterActorsOptions = {
    keywords: string;
    apifyToken: string;
    limit: number;
    offset: number;
    skyfireMode?: boolean;
    userRentedActorIds?: string[];
};

export async function searchActorsByKeywords(
    search: string,
    apifyToken: string,
    limit: number | undefined = undefined,
    offset: number | undefined = undefined,
    allowsAgenticUsers: boolean | undefined = undefined,
): Promise<ExtendedActorStoreList[]> {
    const client = new ApifyClient({ token: apifyToken });
    const storeClient = client.store();
    if (allowsAgenticUsers !== undefined) storeClient.params = { ...storeClient.params, allowsAgenticUsers };

    const results = await storeClient.list({ search, limit, offset });
    return results.items;
}

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
