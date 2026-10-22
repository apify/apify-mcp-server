/** Store search through apify-core's `GET /unstable/store`, mapped to the `/v2/store` item the Actor card renders. */
import type { ActorRunPricingInfo } from 'apify-client';
import { z } from 'zod';

import log from '@apify/log';

import type { ApifyClient } from '../apify_client.js';
import { getApifyAPIBaseUrl } from '../apify_client.js';
import type { ActorStoreList } from '../types.js';

// Read once at import, so the tool schema and the routing always agree.
export const IS_UNSTABLE_STORE_SEARCH_ENABLED = ['true', '1'].includes(process.env.APIFY_STORE_UNSTABLE_ENDPOINT ?? '');

export const UNSTABLE_STORE_CARD_FIELDS = [
    'name',
    'username',
    'title',
    'description',
    'pictureUrl',
    'url',
    'modifiedAt',
    'currentPricingInfo',
    'stats',
    'rating',
    'categories',
    'inputSchema',
] as const;

const unstableStoreItemSchema = z.object({
    id: z.string(),
    name: z.string(),
    username: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    pictureUrl: z.string().optional(),
    url: z.string(),
    modifiedAt: z.iso.datetime().optional(),
    // `pricing_info.ts` reads the fields it knows and tolerates the rest.
    currentPricingInfo: z.custom<ActorRunPricingInfo>(
        (value) => typeof (value as { pricingModel?: unknown } | null)?.pricingModel === 'string',
    ),
    stats: z
        .object({
            totalUsers: z.number().optional(),
            totalUsers30Days: z.number().optional(),
            bookmarkCount: z.number().optional(),
        })
        .optional(),
    rating: z.object({ average: z.number().optional(), reviewCount: z.number().optional() }).optional(),
    categories: z.array(z.string()).optional(),
    inputSchema: z
        .object({
            type: z.literal('object'),
            properties: z.record(z.string(), z.object({ type: z.union([z.string(), z.array(z.string())]) })),
            required: z.array(z.string()).optional(),
        })
        .optional(),
});

const unstableStorePageSchema = z.object({
    data: z.object({
        items: z.array(unstableStoreItemSchema),
        count: z.number(),
        limit: z.number(),
        recommId: z.string().optional(),
    }),
});

export type UnstableStoreItem = z.infer<typeof unstableStoreItemSchema>;

export type UnstableStoreSearchOptions = {
    search: string;
    apifyClient: ApifyClient;
    limit: number;
    cursor?: string;
    allowsAgenticUsers?: boolean;
};

export type UnstableStoreSearchPage = {
    actors: ActorStoreList[];
    /** Absent when the store failed to rank the page. */
    nextCursor?: string;
};

export function buildUnstableStoreSearchUrl(options: Omit<UnstableStoreSearchOptions, 'apifyClient'>): URL {
    const url = new URL('/unstable/store', getApifyAPIBaseUrl());
    if (options.search) url.searchParams.set('search', options.search);
    url.searchParams.set('limit', String(options.limit));
    url.searchParams.set('fields', UNSTABLE_STORE_CARD_FIELDS.join(','));
    if (options.cursor) url.searchParams.set('recommId', options.cursor);
    if (options.allowsAgenticUsers !== undefined) {
        url.searchParams.set('allowsAgenticUsers', String(options.allowsAgenticUsers));
    }
    return url;
}

/** A field the endpoint omits stays absent, as on `/v2/store`, so the card renders both the same. */
export function mapUnstableStoreItem(item: UnstableStoreItem): ActorStoreList {
    const stats: ActorStoreList['stats'] = {
        ...(item.stats?.totalUsers !== undefined && { totalUsers: item.stats.totalUsers }),
        ...(item.stats?.totalUsers30Days !== undefined && { totalUsers30Days: item.stats.totalUsers30Days }),
        ...(item.stats?.bookmarkCount !== undefined && { bookmarkCount: item.stats.bookmarkCount }),
    };
    const mapped: ActorStoreList & { modifiedAt?: Date } = {
        id: item.id,
        name: item.name,
        username: item.username,
        title: item.title,
        description: item.description,
        pictureUrl: item.pictureUrl,
        url: item.url,
        // apify-client parses the `/v2/store` dates, and the card formats a Date.
        ...(item.modifiedAt !== undefined && { modifiedAt: new Date(item.modifiedAt) }),
        currentPricingInfo: item.currentPricingInfo,
        stats,
        ...(item.stats?.bookmarkCount !== undefined && { bookmarkCount: item.stats.bookmarkCount }),
        ...(item.rating?.average !== undefined && { actorReviewRating: item.rating.average }),
        ...(item.rating?.reviewCount !== undefined && { actorReviewCount: item.rating.reviewCount }),
        categories: item.categories,
        inputSchema: item.inputSchema,
    };
    return mapped;
}

export async function searchActorsViaUnstableEndpoint(
    options: UnstableStoreSearchOptions,
): Promise<UnstableStoreSearchPage> {
    const { apifyClient, ...query } = options;
    // Carries the token, origin and payment headers, and resolves non-2xx responses instead of throwing.
    const response = await apifyClient.httpClient.axios.request({
        url: buildUnstableStoreSearchUrl(query).toString(),
        method: 'GET',
    });
    if (response.status >= 300) {
        const apiMessage = (response.data as { error?: { message?: unknown } } | undefined)?.error?.message;
        const message = typeof apiMessage === 'string' ? apiMessage : `Request failed with status ${response.status}`;
        throw Object.assign(new Error(`Store search failed: ${message}`), { statusCode: response.status });
    }

    const parsed = unstableStorePageSchema.safeParse(response.data);
    if (!parsed.success) {
        // A server-side contract break, so it must not read as a client error.
        log.error('Store search: GET /unstable/store returned an unexpected response', { issues: parsed.error.issues });
        throw new Error('Store search failed: the store returned an unexpected response.');
    }
    const page = parsed.data.data;
    return {
        actors: page.items.map(mapUnstableStoreItem),
        // An empty page does not end the results: the store drops Actors after ranking.
        ...(page.recommId ? { nextCursor: page.recommId } : {}),
    };
}
