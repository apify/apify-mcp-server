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

/** Zero-results guidance both search-actors variants return for SEARCH_KEYWORDS. */
export const NO_ACTORS_FOUND_TEXT = `No Actors were found for the search query "${SEARCH_KEYWORDS}".
Keywords can include the named platform and/or data type (e.g. "TikTok posts").
A platform-only query such as "TikTok" is an option if more specific results do not fit.`;
