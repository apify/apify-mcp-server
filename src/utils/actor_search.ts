/**
 * Shared utility for searching and filtering actors.
 * Combines searchActorsByKeywords with filterRentalActors to prevent accidental omission
 * of the filtering step and reduce code duplication.
 */

import { ApifyClient } from '../apify_client.js';
import { ACTOR_PRICING_MODEL, STORE_INPUT_SCHEMA_PAGE_LIMIT } from '../const.js';
import type { PaymentProvider } from '../payments/types.js';
import type { ActorStoreList } from '../types.js';

/**
 * Used in search Actors tool to search above the input supplied limit,
 * so we can safely filter out rental Actors from the search and ensure we return some results.
 */
const ACTOR_SEARCH_ABOVE_LIMIT = 50;
type ActorPricingModel = (typeof ACTOR_PRICING_MODEL)[keyof typeof ACTOR_PRICING_MODEL];

export type SearchActorsByKeywordsOptions = {
    search: string;
    apifyToken: string;
    limit?: number;
    offset?: number;
    allowsAgenticUsers?: boolean;
    /**
     * Ask `GET /v2/store` to project a compact `inputSchema` per Actor (apify-core #27466).
     * Forces `limit <= STORE_INPUT_SCHEMA_PAGE_LIMIT`; the API rejects larger pages.
     */
    includeInputSchema?: boolean;
};

export type SearchAndFilterActorsOptions = {
    keywords: string;
    apifyToken: string;
    limit: number;
    offset: number;
    paymentProvider?: PaymentProvider;
    userRentedActorIds?: string[];
};

export async function searchActorsByKeywords(
    options: SearchActorsByKeywordsOptions,
): Promise<ActorStoreList[]> {
    const { search, apifyToken, limit, offset, allowsAgenticUsers, includeInputSchema } = options;
    const client = new ApifyClient({ token: apifyToken });
    const storeClient = client.store();
    // `params` are merged with endpoint params on every request; both flags are
    // passed through here because `StoreCollectionListOptions` does not type them.
    const params: Record<string, unknown> = { ...storeClient.params };
    if (allowsAgenticUsers !== undefined) params.allowsAgenticUsers = allowsAgenticUsers;
    if (includeInputSchema !== undefined) params.includeInputSchema = includeInputSchema;
    storeClient.params = params;

    const results = await storeClient.list({ search, limit, offset });
    return results.items as ActorStoreList[];
}

/**
 * Search actors by keywords and filter rental actors. Pages through `/v2/store`
 * with `includeInputSchema=true` (capped at {@link STORE_INPUT_SCHEMA_PAGE_LIMIT}
 * per page by the API) until `limit` non-rental Actors are collected or the
 * `ACTOR_SEARCH_ABOVE_LIMIT` scan budget is exhausted.
 *
 * @param options Search and filter options
 * @returns Array of filtered actors, limited to the specified limit
 */
export async function searchAndFilterActors(
    options: SearchAndFilterActorsOptions,
): Promise<ActorStoreList[]> {
    const { keywords, apifyToken, limit, offset, paymentProvider, userRentedActorIds } = options;
    const allowsAgenticUsers = paymentProvider ? true : undefined;
    const scanBudget = limit + ACTOR_SEARCH_ABOVE_LIMIT;
    const filtered: ActorStoreList[] = [];
    let pageOffset = offset;
    let scanned = 0;

    while (filtered.length < limit && scanned < scanBudget) {
        const pageSize = Math.min(STORE_INPUT_SCHEMA_PAGE_LIMIT, scanBudget - scanned);
        const page = await searchActorsByKeywords({
            search: keywords,
            apifyToken,
            limit: pageSize,
            offset: pageOffset,
            allowsAgenticUsers,
            includeInputSchema: true,
        });
        if (page.length === 0) break; // no more results upstream
        filtered.push(...filterRentalActors(page, userRentedActorIds || []));
        scanned += page.length;
        pageOffset += page.length;
        // Store API returned fewer items than requested → end of results, no point in another roundtrip.
        if (page.length < pageSize) break;
    }
    return filtered.slice(0, limit);
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
        actor.currentPricingInfo.pricingModel as ActorPricingModel) !== ACTOR_PRICING_MODEL.FLAT_PRICE_PER_MONTH
        || userRentedActorIds.includes(actor.id),
    );
}
