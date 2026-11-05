/** Store search through apify-core's `GET /unstable/store`, mapped to the `/v2/store` item the Actor card renders. */
import type { ActorRunPricingInfo } from 'apify-client';
import { z } from 'zod';

import log from '@apify/log';

import type { ApifyClient } from '../apify_client.js';
import { getApifyAPIBaseUrl, sendApifyApiRequest } from '../apify_client.js';
import type { ActorStoreList } from '../types.js';

// Read once at import, so the tool schema and the routing always agree.
export const IS_UNSTABLE_STORE_SEARCH_ENABLED = ['true', '1'].includes(process.env.APIFY_STORE_UNSTABLE_ENDPOINT ?? '');

/**
 * The base fields every item has. The rest is apify-core's to change: a field the card knows is
 * rendered as such, and any other, or one in a shape the card does not know, is shown as it comes.
 */
const unstableStoreItemSchema = z.looseObject({
    id: z.string(),
    name: z.string(),
    username: z.string(),
    title: z.string(),
    url: z.string(),
    // `pricing_info.ts` reads the fields it knows and tolerates the rest.
    currentPricingInfo: z.custom<ActorRunPricingInfo>(
        (value) => typeof (value as { pricingModel?: unknown } | null)?.pricingModel === 'string',
    ),
});

const knownStoreFieldSchemas = {
    description: z.string(),
    pictureUrl: z.string(),
    modifiedAt: z.iso.datetime(),
    stats: z.strictObject({
        totalUsers: z.number().optional(),
        totalUsers30Days: z.number().optional(),
        bookmarkCount: z.number().optional(),
    }),
    rating: z.strictObject({ average: z.number().optional(), reviewCount: z.number().optional() }),
    categories: z.array(z.string()),
    inputSchema: z.object({
        type: z.literal('object'),
        properties: z.record(z.string(), z.object({ type: z.union([z.string(), z.array(z.string())]) })),
        required: z.array(z.string()).optional(),
    }),
};

type KnownStoreFields = { [K in keyof typeof knownStoreFieldSchemas]?: z.infer<(typeof knownStoreFieldSchemas)[K]> };

const isKnownStoreField = (key: string): key is keyof typeof knownStoreFieldSchemas =>
    Object.hasOwn(knownStoreFieldSchemas, key);

const BASE_STORE_FIELDS: ReadonlySet<string> = new Set(Object.keys(unstableStoreItemSchema.shape));

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
    /** Sent as `_traceId` and `_useCase`. */
    tracking?: ApifyClient['storeSearchTracking'];
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
    url.searchParams.set('include', 'inputSchema');
    if (options.cursor) url.searchParams.set('recommId', options.cursor);
    if (options.allowsAgenticUsers !== undefined) {
        url.searchParams.set('allowsAgenticUsers', String(options.allowsAgenticUsers));
    }
    if (options.tracking?.useCase) url.searchParams.set('_useCase', options.tracking.useCase);
    if (options.tracking?.traceId) url.searchParams.set('_traceId', options.tracking.traceId);
    return url;
}

/** `null`, a blank string, `[]` or `{}`: the card would show the label with nothing after it. */
const isEmptyStoreValue = (value: unknown) =>
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.trim() === '') ||
    (typeof value === 'object' && Object.keys(value).length === 0);

/** A field the endpoint omits or leaves empty stays absent, as on `/v2/store`, so the card renders both the same. */
export function mapUnstableStoreItem(item: UnstableStoreItem): ActorStoreList {
    const known: KnownStoreFields = {};
    const extraFields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(item)) {
        if (BASE_STORE_FIELDS.has(key) || isEmptyStoreValue(value)) continue;
        const parsed = isKnownStoreField(key) ? knownStoreFieldSchemas[key].safeParse(value) : undefined;
        if (parsed?.success) {
            Object.assign(known, { [key]: parsed.data });
        } else {
            extraFields[key] = value;
        }
    }

    const stats: ActorStoreList['stats'] = {
        ...(known.stats?.totalUsers !== undefined && { totalUsers: known.stats.totalUsers }),
        ...(known.stats?.totalUsers30Days !== undefined && { totalUsers30Days: known.stats.totalUsers30Days }),
        ...(known.stats?.bookmarkCount !== undefined && { bookmarkCount: known.stats.bookmarkCount }),
    };
    const mapped: ActorStoreList & { modifiedAt?: Date } = {
        id: item.id,
        name: item.name,
        username: item.username,
        title: item.title,
        description: known.description,
        pictureUrl: known.pictureUrl,
        url: item.url,
        // apify-client parses the `/v2/store` dates, and the card formats a Date.
        ...(known.modifiedAt !== undefined && { modifiedAt: new Date(known.modifiedAt) }),
        currentPricingInfo: item.currentPricingInfo,
        stats,
        ...(known.stats?.bookmarkCount !== undefined && { bookmarkCount: known.stats.bookmarkCount }),
        ...(known.rating?.average !== undefined && { actorReviewRating: known.rating.average }),
        ...(known.rating?.reviewCount !== undefined && { actorReviewCount: known.rating.reviewCount }),
        categories: known.categories,
        inputSchema: known.inputSchema,
        ...(Object.keys(extraFields).length > 0 && { extraFields }),
    };
    return mapped;
}

export async function searchActorsViaUnstableEndpoint(
    options: UnstableStoreSearchOptions,
): Promise<UnstableStoreSearchPage> {
    const { apifyClient, ...query } = options;
    const response = await sendApifyApiRequest(apifyClient, {
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
