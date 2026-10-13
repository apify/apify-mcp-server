import { ACTOR_PRICING_MODEL } from '../../src/const.js';
import type { ActorStoreList } from '../../src/types.js';

/** Minimal store-list row for formatActorToStructuredCard / formatActorForWidget. */
export const MOCK_STORE_ACTOR = {
    id: 'actor-id-1',
    title: 'Web Scraper',
    name: 'web-scraper',
    username: 'apify',
    description: 'A web scraper for tests.',
    pictureUrl: 'https://example.com/pic.png',
    notice: null,
    badge: null,
    bookmarkCount: 42,
    actorReviewRating: 4.5,
    actorReviewCount: 10,
    stats: {
        totalUsers: 1000,
        totalUsers30Days: 100,
        actorReviewRating: 4.5,
        actorReviewCount: 10,
    },
    categories: ['SCRAPING'],
    currentPricingInfo: { pricingModel: ACTOR_PRICING_MODEL.FREE },
} as unknown as ActorStoreList;

export const SEARCH_KEYWORDS = 'web scraper';

/** Tiered pricing with enough events to omit their descriptions. */
export const MOCK_PRICED_STORE_ACTOR = {
    ...MOCK_STORE_ACTOR,
    currentPricingInfo: {
        pricingModel: ACTOR_PRICING_MODEL.PAY_PER_EVENT,
        pricingPerEvent: {
            actorChargeEvents: Object.fromEntries(
                Array.from({ length: 6 }, (_, i) => [
                    `event${i}`,
                    {
                        eventTitle: `Event ${i}`,
                        eventDescription: `Description ${i}`,
                        eventTieredPricingUsd: {
                            FREE: { tieredEventPriceUsd: 0.002 },
                            GOLD: { tieredEventPriceUsd: 0.001 },
                        },
                    },
                ]),
            ),
        },
    },
} as unknown as ActorStoreList;
