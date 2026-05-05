/**
 * Shared utility for searching Actors via `GET /v2/store`.
 *
 * `GET /v2/store` returns only `[FREE, PAY_PER_EVENT]` Actors by default
 * (apify-core's `AGENT_SAFE_PRICING_MODELS`) and additionally drops Actors
 * that fail safety checks (KYC, full-permission low-usage, etc.) — so no
 * MCP-side rental over-fetch / filter is needed.
 */

import log from '@apify/log';

import { ApifyClient } from '../apify_client.js';
import { ACTOR_PRICING_MODEL, STORE_INPUT_SCHEMA_PAGE_LIMIT } from '../const.js';
import type { PaymentProvider } from '../payments/types.js';
import type { ActorStoreList } from '../types.js';

export type SearchActorsByKeywordsOptions = {
    search: string;
    apifyToken: string;
    limit?: number;
    offset?: number;
    allowsAgenticUsers?: boolean;
    /**
     * Ask `GET /v2/store` to project a compact `inputSchema` per Actor (apify-core#27466).
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
};

export async function searchActorsByKeywords(
    options: SearchActorsByKeywordsOptions,
): Promise<ActorStoreList[]> {
    const { search, apifyToken, limit, offset, allowsAgenticUsers, includeInputSchema } = options;
    const client = new ApifyClient({ token: apifyToken });
    const storeClient = client.store();
    if (allowsAgenticUsers !== undefined) storeClient.params = { ...storeClient.params, allowsAgenticUsers };
    if (includeInputSchema !== undefined) storeClient.params = { ...storeClient.params, includeInputSchema };

    const results = await storeClient.list({ search, limit, offset });
    return results.items as ActorStoreList[];
}

/**
 * Search Actors by keywords. Requests `includeInputSchema=true` when the
 * caller's `limit` fits within the API cap ({@link STORE_INPUT_SCHEMA_PAGE_LIMIT});
 * larger requests fall back to a plain search since the API rejects the flag
 * above the cap. Tracked in apify-mcp-server#791.
 */
export async function searchAndFilterActors(
    options: SearchAndFilterActorsOptions,
): Promise<ActorStoreList[]> {
    const { keywords, apifyToken, limit, offset, paymentProvider } = options;
    const includeInputSchema = limit <= STORE_INPUT_SCHEMA_PAGE_LIMIT;

    const actors = await searchActorsByKeywords({
        search: keywords,
        apifyToken,
        limit,
        offset,
        allowsAgenticUsers: paymentProvider ? true : undefined,
        includeInputSchema: includeInputSchema || undefined,
    });

    // Observability: apify-core's `AGENT_SAFE_PRICING_MODELS` filter should mean we never see rentals here.
    const rentalActors = actors
        .filter((actor) => actor.currentPricingInfo?.pricingModel === ACTOR_PRICING_MODEL.FLAT_PRICE_PER_MONTH)
        .map((actor) => `${actor.username}/${actor.name}`);
    if (rentalActors.length > 0) {
        log.error('Unexpected rental Actors in store search results', { keywords, rentalActors });
    }

    return actors;
}
