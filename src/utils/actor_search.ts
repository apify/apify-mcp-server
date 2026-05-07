/**
 * Shared utility for searching Actors via `GET /v2/store`.
 *
 * `GET /v2/store` returns only `[FREE, PAY_PER_EVENT]` Actors by default
 * (apify-core's `AGENT_SAFE_PRICING_MODELS`) and additionally drops Actors
 * that fail safety checks (KYC, full-permission low-usage, etc.) — so no
 * MCP-side rental over-fetch / filter is needed.
 */

import { ApifyClient } from '../apify_client.js';
import { MAX_LIMIT_WITH_INPUT_SCHEMA } from '../const.js';
import type { PaymentProvider } from '../payments/types.js';
import type { ActorStoreList } from '../types.js';

export type SearchActorsByKeywordsOptions = {
    search: string;
    apifyToken: string;
    limit?: number;
    offset?: number;
    allowsAgenticUsers?: boolean;
    /** Throws when set with `limit > MAX_LIMIT_WITH_INPUT_SCHEMA` (apify-core 400s above the cap). */
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
    if (includeInputSchema === true && limit !== undefined && limit > MAX_LIMIT_WITH_INPUT_SCHEMA) {
        throw new Error(
            `searchActorsByKeywords: limit (${limit}) exceeds API cap of ${MAX_LIMIT_WITH_INPUT_SCHEMA} when includeInputSchema=true.`,
        );
    }
    const client = new ApifyClient({ token: apifyToken });
    const storeClient = client.store();
    if (allowsAgenticUsers !== undefined) storeClient.params = { ...storeClient.params, allowsAgenticUsers };
    if (includeInputSchema !== undefined) storeClient.params = { ...storeClient.params, includeInputSchema };

    const results = await storeClient.list({ search, limit, offset });
    return results.items as ActorStoreList[];
}

/**
 * Search Actors by keywords with compact input-schema enrichment via
 * `includeInputSchema=true`. The public arg schema caps `limit` at
 * apify-core's hard cap (10), so every result includes `inputSchema`.
 */
export async function searchAndFilterActors(
    options: SearchAndFilterActorsOptions,
): Promise<ActorStoreList[]> {
    const { keywords, apifyToken, limit, offset, paymentProvider } = options;

    return searchActorsByKeywords({
        search: keywords,
        apifyToken,
        limit,
        offset,
        allowsAgenticUsers: paymentProvider ? true : undefined,
        includeInputSchema: true,
    });
}
