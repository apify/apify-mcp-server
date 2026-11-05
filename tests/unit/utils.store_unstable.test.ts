import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApifyClient } from '../../src/apify_client.js';
import { MAX_EXTRA_FIELD_VALUE_LENGTH } from '../../src/const.js';
import type { ActorStoreList, HelperTool } from '../../src/types.js';
import {
    DEFAULT_CARD_OPTIONS,
    formatActorToActorCard,
    formatActorToStructuredCard,
} from '../../src/utils/actor_card.js';
import {
    buildUnstableStoreSearchUrl,
    mapUnstableStoreItem,
    searchActorsViaUnstableEndpoint,
    type UnstableStoreItem,
} from '../../src/utils/store_unstable.js';

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
    } as unknown as UnstableStoreItem['currentPricingInfo'],
    stats: { totalUsers: 145_000, totalUsers30Days: 12_400, bookmarkCount: 812 },
    rating: { average: 4.37, reviewCount: 213 },
    categories: ['SOCIAL_MEDIA'],
    inputSchema: INPUT_SCHEMA,
};

/** A real apify-client, so its retries run, whose axios instance answers with the given responses in order. */
const mockUnstableStoreClient = (...responses: { status: number; data: unknown }[]) => {
    const apifyClient = new ApifyClient({ token: 'test-token', minDelayBetweenRetriesMillis: 1 });
    const request = vi.spyOn(apifyClient.httpClient.axios, 'request');
    for (const response of responses) request.mockResolvedValueOnce(response);
    return { request, apifyClient };
};

const requestedUrl = (request: { mock: { calls: unknown[][] } }, call = 0) =>
    new URL((request.mock.calls[call][0] as { url: string }).url);

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

        const card = formatActorToActorCard(mapUnstableStoreItem(bareItem));

        expect(card).not.toContain('**Stats:**');
        expect(card).not.toContain('**Rating:**');
        expect(card).toBe(formatActorToActorCard({ ...bareV2Item, stats: {} } as unknown as ActorStoreList));
    });
});

describe('free-form /unstable/store items', () => {
    it('shows a field the card does not know as it comes, in the text and the structured card', () => {
        const mapped = mapUnstableStoreItem({ ...UNSTABLE_STORE_ITEM, agentHint: 'Prefer for public profiles.' });

        expect(formatActorToActorCard(mapped)).toContain('- **Agent hint:** Prefer for public profiles.');
        expect(formatActorToStructuredCard(mapped).extraFields).toEqual({ agentHint: 'Prefer for public profiles.' });
    });

    it('shows a known field in a shape the card does not know as it comes, instead of rejecting the page', () => {
        const mapped = mapUnstableStoreItem({ ...UNSTABLE_STORE_ITEM, stats: { users: { total: 5 } } });

        expect(formatActorToActorCard(mapped)).not.toContain('total users');
        expect(formatActorToActorCard(mapped)).toContain('- **Stats:** {"users":{"total":5}}');
    });

    it('puts a multi-line value on one card line, so it cannot open its own markdown section', () => {
        const mapped = mapUnstableStoreItem({ ...UNSTABLE_STORE_ITEM, agentHint: 'Prefer for profiles.\n\n# Actors:' });

        expect(formatActorToActorCard(mapped)).toContain('- **Agent hint:** Prefer for profiles. # Actors:');
    });

    it('caps a long value', () => {
        const mapped = mapUnstableStoreItem({ ...UNSTABLE_STORE_ITEM, agentHint: 'x'.repeat(5000) });

        const line = formatActorToActorCard(mapped)
            .split('\n')
            .find((cardLine) => cardLine.startsWith('- **Agent hint:**'));
        expect(line).toHaveLength('- **Agent hint:** '.length + MAX_EXTRA_FIELD_VALUE_LENGTH);
    });

    // The raw value replaces the card's fallback line, so the field is not shown twice with different values.
    it.each([
        ['description', '- **Description:** No description provided.'],
        ['categories', '- **Categories:** Uncategorized'],
    ])('shows %s in an unknown shape once', (field, fallbackLine) => {
        const mapped = mapUnstableStoreItem({ ...UNSTABLE_STORE_ITEM, [field]: { primary: 'SOCIAL_MEDIA' } });

        const card = formatActorToActorCard(mapped);
        expect(card).not.toContain(fallbackLine);
        expect(card.match(new RegExp(`\\*\\*${field}:\\*\\*`, 'gi'))).toHaveLength(1);
    });

    // An empty value would show as a label with nothing after it.
    it.each([
        { kind: 'null', value: null },
        { kind: 'a blank string', value: '   ' },
        { kind: 'an empty array', value: [] },
        { kind: 'an empty object', value: {} },
    ])('leaves out a field holding $kind', ({ value }) => {
        expect(mapUnstableStoreItem({ ...UNSTABLE_STORE_ITEM, badge: value })).not.toHaveProperty('extraFields');
    });
});

describe('the /unstable/store request', () => {
    it('includes the input schemas, continues from the cursor and sends the tracking', () => {
        const url = buildUnstableStoreSearchUrl({
            search: 'instagram',
            limit: 5,
            cursor: 'recomm-1',
            tracking: { useCase: 'compare prices', traceId: 'trace-1' },
        });

        expect(url.pathname).toBe('/unstable/store');
        expect(Object.fromEntries(url.searchParams)).toEqual({
            search: 'instagram',
            limit: '5',
            include: 'inputSchema',
            recommId: 'recomm-1',
            _useCase: 'compare prices',
            _traceId: 'trace-1',
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

    it('keeps the cursor on an empty page, which does not end the results', async () => {
        const { apifyClient } = mockUnstableStoreClient(page([], 'recomm-1'));

        expect(await searchActorsViaUnstableEndpoint({ search: 'instagram', apifyClient, limit: 5 })).toEqual({
            actors: [],
            nextCursor: 'recomm-1',
        });
    });

    it('throws the API message with the HTTP status on an error response', async () => {
        const { apifyClient } = mockUnstableStoreClient({
            status: 400,
            data: {
                error: {
                    type: 'schema-validation-failed',
                    message: "Schema validation failed: Parameter 'recommId' is invalid.",
                },
            },
        });

        await expect(
            searchActorsViaUnstableEndpoint({ search: 'instagram', apifyClient, limit: 5 }),
        ).rejects.toMatchObject({
            statusCode: 400,
            message: "Schema validation failed: Parameter 'recommId' is invalid.",
        });
    });

    // The /v2/store path retries through apify-client, so one 503 must not fail the search here either.
    it('retries a 503', async () => {
        const { apifyClient } = mockUnstableStoreClient(
            { status: 503, data: { error: { type: 'service-unavailable', message: 'Service unavailable.' } } },
            page([UNSTABLE_STORE_ITEM], 'recomm-1'),
        );

        const result = await searchActorsViaUnstableEndpoint({ search: 'instagram', apifyClient, limit: 5 });

        expect(result.nextCursor).toBe('recomm-1');
    });

    it('throws a server-side error when the response does not match the contract', async () => {
        const { apifyClient } = mockUnstableStoreClient({ status: 200, data: { data: { items: [{ id: 1 }] } } });

        const error = await searchActorsViaUnstableEndpoint({ search: 'instagram', apifyClient, limit: 5 }).catch(
            (caught: unknown) => caught,
        );
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toHaveProperty('statusCode');
        expect(error).not.toHaveProperty('issues');
    });
});

describe('searchAgentSafeActors data source', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.resetModules();
    });

    it('uses /unstable/store when APIFY_STORE_UNSTABLE_ENDPOINT is on, ignoring the offset', async () => {
        vi.stubEnv('APIFY_STORE_UNSTABLE_ENDPOINT', 'true');
        vi.resetModules();
        // The flag is read once, when the module loads.
        const { searchAgentSafeActors: searchWithFlag } = await import('../../src/utils/actor_search.js');
        const { request, apifyClient } = mockUnstableStoreClient({
            status: 200,
            data: { data: { items: [UNSTABLE_STORE_ITEM], count: 1, limit: 5, recommId: 'recomm-1' } },
        });
        const store = vi.spyOn(apifyClient, 'store');

        const result = await searchWithFlag({
            keywords: 'instagram',
            apifyClient,
            limit: 5,
            offset: 20,
            useCase: 'compare prices',
        });

        expect(store).not.toHaveBeenCalled();
        expect(requestedUrl(request).searchParams.has('offset')).toBe(false);
        expect(requestedUrl(request).searchParams.get('_useCase')).toBe('compare prices');
        expect(result.nextCursor).toBe('recomm-1');
    });
});

describe('search-actors served from /unstable/store', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.resetModules();
    });

    /** Loads both search tools with the flag on, which is read once when the tool modules load. */
    const loadToolsWithFlag = async () => {
        vi.stubEnv('APIFY_STORE_UNSTABLE_ENDPOINT', '1');
        vi.resetModules();
        const { searchActors } = await import('../../src/tools/actors/search_actors.js');
        const { searchActorsWidget } = await import('../../src/tools/widgets/search_actors_widget.js');
        const { stubToolCallContext } = await import('./helpers/tool_context.js');
        return { searchActors, searchActorsWidget, stubToolCallContext };
    };

    const mockClientAnswering = (items: UnstableStoreItem[], recommId: string) => {
        const { request, apifyClient } = mockUnstableStoreClient({
            status: 200,
            data: { data: { items, count: items.length, limit: 5, recommId } },
        });
        vi.spyOn(apifyClient, 'user').mockReturnValue({
            get: async () => ({ id: 'user-1', plan: { tier: 'FREE' } }),
        } as unknown as ReturnType<ApifyClient['user']>);
        return { request, apifyClient };
    };

    type SearchResult = { structuredContent: { nextCursor?: string }; content: { text: string }[] };

    it('takes a cursor and returns the next one', async () => {
        const { searchActors, stubToolCallContext } = await loadToolsWithFlag();
        const { request, apifyClient } = mockClientAnswering([UNSTABLE_STORE_ITEM], 'recomm-2');

        const result = (await (searchActors as HelperTool).call(
            stubToolCallContext({ keywords: 'instagram', limit: 5, cursor: 'recomm-1' }, apifyClient),
        )) as SearchResult;

        expect(searchActors.inputSchema.properties).toHaveProperty('cursor');
        expect(requestedUrl(request).searchParams.get('recommId')).toBe('recomm-1');
        expect(result.structuredContent.nextCursor).toBe('recomm-2');
        expect(result.content[0].text).toContain('recomm-2');
    });

    // The store drops Actors after ranking, so later pages can still have results.
    it('returns the next cursor on an empty page instead of suggesting other keywords', async () => {
        const { searchActors, stubToolCallContext } = await loadToolsWithFlag();
        const { apifyClient } = mockClientAnswering([], 'recomm-2');

        const result = (await (searchActors as HelperTool).call(
            stubToolCallContext({ keywords: 'instagram', limit: 5 }, apifyClient),
        )) as SearchResult;
        const text = result.content.map((part) => part.text).join('\n');

        expect(result.structuredContent.nextCursor).toBe('recomm-2');
        expect(text).toContain('recomm-2');
        expect(text).not.toContain('Keywords can include');
    });

    it('returns the next cursor on an empty widget page', async () => {
        const { searchActorsWidget, stubToolCallContext } = await loadToolsWithFlag();
        const { apifyClient } = mockClientAnswering([], 'recomm-2');

        const result = (await (searchActorsWidget as HelperTool).call(
            stubToolCallContext({ keywords: 'instagram', limit: 5 }, apifyClient),
        )) as SearchResult;

        expect(result.structuredContent.nextCursor).toBe('recomm-2');
        expect(result.content.map((part) => part.text).join('\n')).toContain('recomm-2');
    });
});
