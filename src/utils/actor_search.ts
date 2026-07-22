/**
 * Shared utility for searching Actors via `GET /v2/store`.
 *
 * `GET /v2/store` returns only `[FREE, PAY_PER_EVENT]` Actors by default
 * (apify-core's `AGENT_SAFE_PRICING_MODELS`) and additionally drops Actors
 * that fail safety checks (KYC, full-permission low-usage, etc.) — so no
 * MCP-side rental over-fetch / filter is needed.
 */

import type { ApifyClient } from '../apify_client.js';
import type { PaymentProvider } from '../payments/types.js';
import type { ActorStoreList } from '../types.js';

export type SearchActorsByKeywordsOptions = {
    search: string;
    /** Caller's already-configured client — reused so the request-origin header stays correct. */
    apifyClient: ApifyClient;
    limit: number;
    offset?: number;
    allowsAgenticUsers?: boolean;
    /** API rejects values above `MAX_LIMIT_WITH_INPUT_SCHEMA` (apify-core cap). */
    includeInputSchema?: boolean;
};

export type SearchAgentSafeActorsOptions = {
    keywords: string;
    apifyClient: ApifyClient;
    limit: number;
    offset: number;
    paymentProvider?: PaymentProvider;
};

export async function searchActorsByKeywords(options: SearchActorsByKeywordsOptions): Promise<ActorStoreList[]> {
    const { search, apifyClient, limit, offset, allowsAgenticUsers, includeInputSchema } = options;
    const storeClient = apifyClient.store();
    if (allowsAgenticUsers !== undefined) storeClient.params = { ...storeClient.params, allowsAgenticUsers };
    if (includeInputSchema !== undefined) storeClient.params = { ...storeClient.params, includeInputSchema };

    const results = await storeClient.list({ search, limit, offset });
    return results.items as ActorStoreList[];
}

/**
 * Preset around `searchActorsByKeywords` for the agent-facing search tool:
 * always sets `includeInputSchema=true` and forwards `allowsAgenticUsers`
 * when a `paymentProvider` is in play. The public arg schema caps `limit`
 * at apify-core's hard cap (`MAX_LIMIT_WITH_INPUT_SCHEMA`).
 */
export async function searchAgentSafeActors(options: SearchAgentSafeActorsOptions): Promise<ActorStoreList[]> {
    const { keywords, apifyClient, limit, offset, paymentProvider } = options;

    return searchActorsByKeywords({
        search: keywords,
        apifyClient,
        limit,
        offset,
        allowsAgenticUsers: paymentProvider ? true : undefined,
        includeInputSchema: true,
    });
}
