/**
 * Shared utility for searching and filtering actors.
 * Combines searchActorsByKeywords with filterRentalActors to prevent accidental omission
 * of the filtering step and reduce code duplication.
 */

import { ApifyClient } from '../apify-client.js';
import { ACTOR_SEARCH_ABOVE_LIMIT } from '../const.js';
import type { ActorPricingModel, ActorStoreList } from '../types.js';

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
): Promise<ActorStoreList[]> {
    const client = new ApifyClient({ token: apifyToken });
    const storeClient = client.store();
    if (allowsAgenticUsers !== undefined) storeClient.params = { ...storeClient.params, allowsAgenticUsers };

    const results = await storeClient.list({ search, limit, offset });
    return results.items as ActorStoreList[];
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
): Promise<ActorStoreList[]> {
    const { keywords, apifyToken, limit, offset, skyfireMode, userRentedActorIds } = options;

    const actors = await searchActorsByKeywords(
        keywords,
        apifyToken,
        limit + ACTOR_SEARCH_ABOVE_LIMIT,
        offset,
        skyfireMode ? true : undefined,
    );

    return filterRentalActors(actors || [], userRentedActorIds || []).slice(0, limit) as ActorStoreList[];
}

/**
 * Filters out actors with the 'FLAT_PRICE_PER_MONTH' pricing model (rental actors),
 * unless the actor's ID is present in the user's rented actor IDs list.
 *
 * This is necessary because the Store list API does not support filtering by multiple pricing models at once.
 *
 * @param actors - Array of ActorStorePruned objects to filter.
 * @param userRentedActorIds - Array of Actor IDs that the user has rented.
 * @returns Array of Actors excluding those with 'FLAT_PRICE_PER_MONTH' pricing model (= rental Actors),
 *  except for Actors that the user has rented (whose IDs are in userRentedActorIds).
 */
export function filterRentalActors(
    actors: ActorStoreList[],
    userRentedActorIds: string[],
): ActorStoreList[] {
    // Store list API does not support filtering by two pricing models at once,
    // so we filter the results manually after fetching them.
    return actors.filter((actor) => (
        actor.currentPricingInfo.pricingModel as ActorPricingModel) !== 'FLAT_PRICE_PER_MONTH'
        || userRentedActorIds.includes(actor.id),
    );
}
