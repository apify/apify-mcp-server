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
    /** Sent as `_traceId` and `_useCase`. */
    tracking?: ApifyClient['storeSearchTracking'];
};

export type SearchAgentSafeActorsOptions = {
    keywords: string;
    apifyClient: ApifyClient;
    limit: number;
    offset: number;
    paymentProvider?: PaymentProvider;
};

export async function searchActorsByKeywords(options: SearchActorsByKeywordsOptions): Promise<ActorStoreList[]> {
    const { search, apifyClient, limit, offset, allowsAgenticUsers, includeInputSchema, tracking } = options;
    const storeClient = apifyClient.store();
    storeClient.params = { ...storeClient.params, _useNewStoreBackend: true };
    if (allowsAgenticUsers !== undefined) storeClient.params = { ...storeClient.params, allowsAgenticUsers };
    if (includeInputSchema !== undefined) storeClient.params = { ...storeClient.params, includeInputSchema };
    const { traceId, useCase } = tracking ?? {};
    if (traceId) storeClient.params = { ...storeClient.params, _traceId: traceId };
    if (useCase) storeClient.params = { ...storeClient.params, _useCase: useCase };

    try {
        const results = await storeClient.list({ search, limit, offset });
        return results.items as ActorStoreList[];
    } catch (error) {
        // Mask a use case the API echoes back, so it stays out of logs and telemetry.
        if (useCase && error instanceof Error) {
            error.message = error.message.replaceAll(useCase, '[use case]');
            error.stack = error.stack?.replaceAll(useCase, '[use case]');
        }
        throw error;
    }
}

/**
 * Store search used by the `search-actors` tools (plain and widget).
 * Always requests input schemas, so `limit` must stay within `MAX_LIMIT_WITH_INPUT_SCHEMA` (the tool's arg schema enforces it).
 * With a payment provider, returns only Actors that allow agentic users.
 */
export async function searchAgentSafeActors(options: SearchAgentSafeActorsOptions): Promise<ActorStoreList[]> {
    const { keywords, apifyClient, limit, offset, paymentProvider } = options;

    return searchActorsByKeywords({
        // The Store returns no Actors for keywords without letters or digits (" ", "%", "..."),
        // so send them as empty keywords.
        search: /[\p{L}\p{N}]/u.test(keywords) ? keywords : '',
        apifyClient,
        limit,
        offset,
        tracking: apifyClient.storeSearchTracking,
        allowsAgenticUsers: paymentProvider ? true : undefined,
        includeInputSchema: true,
    });
}
