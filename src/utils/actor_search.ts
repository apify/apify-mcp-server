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
import {
    IS_UNSTABLE_STORE_SEARCH_ENABLED,
    searchActorsViaUnstableEndpoint,
    type UnstableStoreSearchPage,
} from './store_unstable.js';

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
    /** Pages `GET /v2/store`; ignored on `/unstable/store`, which pages by `cursor`. */
    offset: number;
    /** The `nextCursor` of the previous page; only `/unstable/store` returns one. */
    cursor?: string;
    paymentProvider?: PaymentProvider;
};

export type AgentSafeActorsPage = UnstableStoreSearchPage;

export async function searchActorsByKeywords(options: SearchActorsByKeywordsOptions): Promise<ActorStoreList[]> {
    const { search, apifyClient, limit, offset, allowsAgenticUsers, includeInputSchema } = options;
    const storeClient = apifyClient.store();
    if (allowsAgenticUsers !== undefined) storeClient.params = { ...storeClient.params, allowsAgenticUsers };
    if (includeInputSchema !== undefined) storeClient.params = { ...storeClient.params, includeInputSchema };

    const results = await storeClient.list({ search, limit, offset });
    return results.items as ActorStoreList[];
}

/**
 * Preset around `searchActorsByKeywords` for the agent-facing search tool, or the `/unstable/store`
 * search when `APIFY_STORE_UNSTABLE_ENDPOINT` is on:
 * always sets `includeInputSchema=true` and forwards `allowsAgenticUsers`
 * when a `paymentProvider` is in play. The public arg schema caps `limit`
 * at apify-core's hard cap (`MAX_LIMIT_WITH_INPUT_SCHEMA`).
 */
export async function searchAgentSafeActors(options: SearchAgentSafeActorsOptions): Promise<AgentSafeActorsPage> {
    const { keywords, apifyClient, limit, offset, cursor, paymentProvider } = options;
    const allowsAgenticUsers = paymentProvider ? true : undefined;

    if (IS_UNSTABLE_STORE_SEARCH_ENABLED) {
        return searchActorsViaUnstableEndpoint({ search: keywords, apifyClient, limit, cursor, allowsAgenticUsers });
    }

    const actors = await searchActorsByKeywords({
        search: keywords,
        apifyClient,
        limit,
        offset,
        allowsAgenticUsers,
        includeInputSchema: true,
    });
    return { actors };
}
