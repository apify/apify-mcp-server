import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ActorStoreList, HelperTool } from '../../src/types.js';
import {
    DEFAULT_CARD_OPTIONS,
    formatActorToActorCard,
    formatActorToStructuredCard,
} from '../../src/utils/actor_card.js';
import { searchAgentSafeActors } from '../../src/utils/actor_search.js';
import {
    buildUnstableStoreSearchUrl,
    mapUnstableStoreItem,
    searchActorsViaUnstableEndpoint,
    UNSTABLE_STORE_CARD_FIELDS,
    type UnstableStoreItem,
} from '../../src/utils/store_unstable.js';
import { mockApifyClient } from './helpers/tool_context.js';

const tieredEventPrices = (priceUsd: number) =>
    Object.fromEntries(
        ['FREE', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND'].map((tier, index) => [
            tier,
            { tieredEventPriceUsd: priceUsd - index * 0.0005 },
        ]),
    );

const PRICING_PER_EVENT = {
    actorChargeEvents: {
        'actor-start': {
            eventTitle: 'Actor start',
            eventDescription: 'Charged once per run.',
            eventPriceUsd: 0.01,
            isOneTimeEvent: true,
        },
        result: {
            eventTitle: 'Result',
            eventDescription: 'Per scraped post.',
            eventTieredPricingUsd: tieredEventPrices(0.005),
            isPrimaryEvent: true,
        },
    },
};

const INPUT_SCHEMA = {
    type: 'object' as const,
    properties: { directUrls: { type: 'array' }, resultsLimit: { type: 'integer' } },
    required: ['directUrls'],
};

/** `apify/instagram-scraper` as `GET /v2/store` returns it through apify-client, which parses the dates. */
const V2_STORE_ITEM = {
    id: 'shu8hvrXbJbY3Eb9W',
    name: 'instagram-scraper',
    username: 'apify',
    title: 'Instagram Scraper',
    description: 'Scrape Instagram posts, profiles and comments.',
    pictureUrl: 'https://images.apifyusercontent.com/instagram.png',
    url: 'https://apify.com/apify/instagram-scraper',
    modifiedAt: new Date('2026-09-14T08:15:00.000Z'),
    bookmarkCount: 812,
    actorReviewRating: 4.37,
    actorReviewCount: 213,
    stats: { totalUsers: 145_000, totalUsers30Days: 12_400, totalBuilds: 900, totalRuns: 9_000_000 },
    categories: ['SOCIAL_MEDIA'],
    currentPricingInfo: {
        pricingModel: 'PAY_PER_EVENT',
        pricingPerEvent: PRICING_PER_EVENT,
        minimalMaxTotalChargeUsd: 0.5,
        apifyMarginPercentage: 0.2,
        startedAt: new Date('2025-01-01T00:00:00.000Z'),
    },
    inputSchema: INPUT_SCHEMA,
} as unknown as ActorStoreList;

/** The same Actor as `GET /unstable/store` returns it with the card fields. */
const UNSTABLE_STORE_ITEM: UnstableStoreItem = {
    id: 'shu8hvrXbJbY3Eb9W',
    name: 'instagram-scraper',
    username: 'apify',
    title: 'Instagram Scraper',
    description: 'Scrape Instagram posts, profiles and comments.',
    pictureUrl: 'https://images.apifyusercontent.com/instagram.png',
    url: 'https://apify.com/apify/instagram-scraper',
    modifiedAt: '2026-09-14T08:15:00.000Z',
    currentPricingInfo: {
        pricingModel: 'PAY_PER_EVENT',
        pricingPerEvent: PRICING_PER_EVENT,
        minimalMaxTotalChargeUsd: 0.5,
    },
    stats: { totalUsers: 145_000, totalUsers30Days: 12_400, bookmarkCount: 812 },
    rating: { average: 4.37, reviewCount: 213 },
    categories: ['SOCIAL_MEDIA'],
    inputSchema: INPUT_SCHEMA,
};

/** An apify-client whose axios instance answers with the given `GET /unstable/store` responses in order. */
const mockUnstableStoreClient = (...responses: { status: number; data: unknown }[]) => {
    const request = vi.fn();
    for (const response of responses) request.mockResolvedValueOnce(response);
    return { request, apifyClient: mockApifyClient({ httpClient: { axios: { request } } }) };
};

const requestedUrl = (request: ReturnType<typeof vi.fn>, call = 0) => new URL(request.mock.calls[call][0].url);

describe('the Actor card renders an /unstable/store item exactly like the /v2/store item', () => {
    // Both paths feed the same card builder, so the mapping is the only place they can diverge.
    it.each(['FREE', 'GOLD'] as const)('for the %s tier', (userTier) => {
        const options = { ...DEFAULT_CARD_OPTIONS, userTier, simplifyPricingForUserTier: true };
        const mapped = mapUnstableStoreItem(UNSTABLE_STORE_ITEM);

        expect(formatActorToActorCard(mapped, options)).toBe(formatActorToActorCard(V2_STORE_ITEM, options));
        expect(formatActorToStructuredCard(mapped, options)).toStrictEqual(
            formatActorToStructuredCard(V2_STORE_ITEM, options),
        );
    });

    it('leaves out the stats and rating lines when the endpoint omits them, as /v2/store does', () => {
        const { stats: _stats, rating: _rating, ...bareItem } = UNSTABLE_STORE_ITEM;
        const {
            stats: _v2Stats,
            bookmarkCount,
            actorReviewRating,
            actorReviewCount,
            ...bareV2Item
        } = V2_STORE_ITEM as ActorStoreList & Record<string, unknown>;

        expect(formatActorToActorCard(mapUnstableStoreItem(bareItem))).toBe(
            formatActorToActorCard({ ...bareV2Item, stats: {} } as unknown as ActorStoreList),
        );
    });
});

describe('the /unstable/store request', () => {
    it('asks for the card fields and continues from the cursor', () => {
        const url = buildUnstableStoreSearchUrl({ search: 'instagram', limit: 5, cursor: 'recomm-1' });

        expect(url.pathname).toBe('/unstable/store');
        expect(Object.fromEntries(url.searchParams)).toEqual({
            search: 'instagram',
            limit: '5',
            fields: UNSTABLE_STORE_CARD_FIELDS.join(','),
            recommId: 'recomm-1',
        });
    });

    it('browses without a search when the keywords are empty, and forwards the agentic filter', () => {
        const url = buildUnstableStoreSearchUrl({ search: '', limit: 5, allowsAgenticUsers: true });

        expect(url.searchParams.has('search')).toBe(false);
        expect(url.searchParams.get('allowsAgenticUsers')).toBe('true');
    });
});

describe('paging /unstable/store by cursor', () => {
    const page = (items: UnstableStoreItem[], recommId?: string) => ({
        status: 200,
        data: { data: { items, count: items.length, limit: 5, ...(recommId && { recommId }) } },
    });

    it('returns the recommId as nextCursor and sends it back for the next page', async () => {
        const { request, apifyClient } = mockUnstableStoreClient(
            page([UNSTABLE_STORE_ITEM], 'recomm-1'),
            page([{ ...UNSTABLE_STORE_ITEM, id: 'second-page-actor' }], 'recomm-2'),
        );

        const first = await searchActorsViaUnstableEndpoint({ search: 'instagram', apifyClient, limit: 5 });
        const next = await searchActorsViaUnstableEndpoint({
            search: 'instagram',
            apifyClient,
            limit: 5,
            cursor: first.nextCursor,
        });

        expect(first.nextCursor).toBe('recomm-1');
        expect(requestedUrl(request, 1).searchParams.get('recommId')).toBe('recomm-1');
        expect(next.actors.map((actor) => actor.id)).toEqual(['second-page-actor']);
        expect(next.nextCursor).toBe('recomm-2');
    });

    it('returns no cursor for an empty page', async () => {
        const { apifyClient } = mockUnstableStoreClient(page([], 'recomm-1'));

        expect(await searchActorsViaUnstableEndpoint({ search: 'instagram', apifyClient, limit: 5 })).toEqual({
            actors: [],
        });
    });

    it('throws on an error response', async () => {
        const { apifyClient } = mockUnstableStoreClient({
            status: 400,
            data: { error: { type: 'invalid-parameter', message: "Parameter 'recommId' is invalid." } },
        });

        await expect(searchActorsViaUnstableEndpoint({ search: 'instagram', apifyClient, limit: 5 })).rejects.toThrow(
            /status 400.*invalid-parameter/,
        );
    });

    it('rejects a response that does not match the contract', async () => {
        const { apifyClient } = mockUnstableStoreClient({ status: 200, data: { data: { items: [{ id: 1 }] } } });

        await expect(searchActorsViaUnstableEndpoint({ search: 'instagram', apifyClient, limit: 5 })).rejects.toThrow();
    });
});

describe('searchAgentSafeActors data source', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('uses /unstable/store when APIFY_STORE_UNSTABLE_ENDPOINT is on, ignoring the offset', async () => {
        vi.stubEnv('APIFY_STORE_UNSTABLE_ENDPOINT', 'true');
        const store = vi.fn();
        const request = vi.fn().mockResolvedValue({
            status: 200,
            data: { data: { items: [UNSTABLE_STORE_ITEM], count: 1, limit: 5, recommId: 'recomm-1' } },
        });
        const apifyClient = mockApifyClient({ store, httpClient: { axios: { request } } });

        const result = await searchAgentSafeActors({ keywords: 'instagram', apifyClient, limit: 5, offset: 20 });

        expect(store).not.toHaveBeenCalled();
        expect(requestedUrl(request).searchParams.has('offset')).toBe(false);
        expect(result.nextCursor).toBe('recomm-1');
    });
});

describe('search-actors served from /unstable/store', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.resetModules();
    });

    it('takes a cursor and returns the next one', async () => {
        vi.stubEnv('APIFY_STORE_UNSTABLE_ENDPOINT', '1');
        vi.resetModules();
        // The flag is read once when the tool module loads.
        const { searchActors } = await import('../../src/tools/actors/search_actors.js');
        const { stubToolCallContext } = await import('./helpers/tool_context.js');
        const request = vi.fn().mockResolvedValue({
            status: 200,
            data: { data: { items: [UNSTABLE_STORE_ITEM], count: 1, limit: 5, recommId: 'recomm-2' } },
        });
        const apifyClient = mockApifyClient({
            httpClient: { axios: { request } },
            user: () => ({ get: async () => ({ id: 'user-1', plan: { tier: 'FREE' } }) }),
        });

        const result = (await (searchActors as HelperTool).call(
            stubToolCallContext({ keywords: 'instagram', limit: 5, cursor: 'recomm-1' }, apifyClient),
        )) as { structuredContent: { nextCursor?: string }; content: { text: string }[] };

        expect(searchActors.inputSchema.properties).toHaveProperty('cursor');
        expect(requestedUrl(request).searchParams.get('recommId')).toBe('recomm-1');
        expect(result.structuredContent.nextCursor).toBe('recomm-2');
        expect(result.content[0].text).toContain('recomm-2');
    });
});
