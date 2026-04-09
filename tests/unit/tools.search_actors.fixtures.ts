import { ACTOR_PRICING_MODEL } from '../../src/const.js';
import type { ActorStoreList, InternalToolArgs } from '../../src/types.js';

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

export function stubInternalToolArgs(args: Record<string, unknown>): InternalToolArgs {
    return {
        args,
        apifyToken: 'test-token',
        extra: {} as InternalToolArgs['extra'],
        mcpServer: {} as InternalToolArgs['mcpServer'],
        apifyClient: {} as InternalToolArgs['apifyClient'],
        apifyMcpServer: { options: { paymentProvider: undefined } } as InternalToolArgs['apifyMcpServer'],
    };
}
