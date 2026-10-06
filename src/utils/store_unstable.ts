/**
 * POC: fetch Store search results from apify-core's unified `/unstable/store/search`
 * endpoint instead of `GET /v2/store`. The enrichment (input schema, tier-aware
 * pricing, stats) moves server-side; this module only maps the response back into
 * the `ActorStoreList` shape the existing Actor-card renderer consumes.
 *
 * Everything the MCP side needs to reconcile with the backend contract lives here,
 * in `mapEnrichedStoreActorToStoreList`.
 */

import type { ActorRunPricingInfo, ActorStoreList as ActorStoreListOutdated } from 'apify-client';

import type { ApifyClient } from '../apify_client.js';
import { getApifyAPIBaseUrl } from '../apify_client.js';
import type { ActorStoreInputSchema, ActorStoreList } from '../types.js';

/** `include=` values requested from the endpoint — the fields the Actor card renders. */
const STORE_SEARCH_INCLUDE = 'inputSchema,pricing,stats,rating,categories';

export function isUnstableStoreSearchEnabled(): boolean {
    const flag = process.env.APIFY_STORE_UNSTABLE_ENDPOINT;
    return flag === 'true' || flag === '1';
}

export type EnrichedStoreActorStats = {
    totalUsers?: number;
    totalUsers30Days?: number;
    bookmarkCount?: number;
};

/** One item of `GET /unstable/store/search` → `data.items[]`, per store-backend-unstable/POC.md. */
export type EnrichedStoreActor = {
    id: string;
    name: string;
    username: string;
    title?: string;
    description?: string;
    pictureUrl?: string;
    url?: string;
    inputSchema?: ActorStoreInputSchema;
    currentPricingInfo?: ActorRunPricingInfo;
    stats?: EnrichedStoreActorStats;
    rating?: number;
    categories?: string[];
};

export type UnstableStoreSearchResponse = {
    data: {
        items: EnrichedStoreActor[];
        total: number;
        offset: number;
        limit: number;
    };
};

export type SearchActorsViaUnstableOptions = {
    search: string;
    apifyClient: ApifyClient;
    limit: number;
    offset: number;
    allowsAgenticUsers?: boolean;
};

export function mapEnrichedStoreActorToStoreList(item: EnrichedStoreActor): ActorStoreList {
    const mapped = {
        id: item.id,
        name: item.name,
        username: item.username,
        title: item.title,
        description: item.description,
        pictureUrl: item.pictureUrl,
        categories: item.categories,
        inputSchema: item.inputSchema,
        currentPricingInfo: item.currentPricingInfo,
        actorReviewRating: item.rating,
        bookmarkCount: item.stats?.bookmarkCount,
        stats: {
            totalUsers: item.stats?.totalUsers ?? 0,
            totalUsers30Days: item.stats?.totalUsers30Days ?? 0,
            bookmarkCount: item.stats?.bookmarkCount,
            actorReviewRating: item.rating,
        },
    };
    return mapped as unknown as ActorStoreList & ActorStoreListOutdated;
}

export async function searchActorsViaUnstableEndpoint(
    options: SearchActorsViaUnstableOptions,
): Promise<ActorStoreList[]> {
    const { search, apifyClient, limit, offset, allowsAgenticUsers } = options;

    const url = new URL('/unstable/store/search', getApifyAPIBaseUrl());
    url.searchParams.set('search', search);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('include', STORE_SEARCH_INCLUDE);
    if (allowsAgenticUsers !== undefined) url.searchParams.set('allowsAgenticUsers', String(allowsAgenticUsers));

    // Reuse the client's axios instance so the token, MCP-origin header and any payment
    // headers (instance defaults) still apply. This instance resolves non-2xx instead of throwing.
    const response = await apifyClient.httpClient.axios.request<UnstableStoreSearchResponse>({
        url: url.toString(),
        method: 'GET',
    });

    if (response.status >= 300) {
        throw new Error(`GET /unstable/store/search failed with status ${response.status}`);
    }

    const items = response.data?.data?.items ?? [];
    return items.map(mapEnrichedStoreActorToStoreList);
}
