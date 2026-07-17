import { describe, expect, it } from 'vitest';

import { ACTOR_PRICING_MODEL } from '../../src/const.js';
import type { ActorStoreList } from '../../src/types.js';
import { formatActorForWidget } from '../../src/utils/actor_card.js';
import type { PricingInfo } from '../../src/utils/pricing_info.js';
import { formatPricing } from '../../src/web/src/utils/formatting.js';

/**
 * Mirrors xtdata/twitter-x-scraper current PAY_PER_EVENT pricing
 * (see https://github.com/apify/apify-mcp-server/issues/905).
 * Public Store page shows: "from $0.25 / 1,000 each tweet. cheaper for higher plans"
 */
const twitterXScraperPricing = {
    pricingModel: ACTOR_PRICING_MODEL.PAY_PER_EVENT,
    pricingPerEvent: {
        actorChargeEvents: {
            start: {
                eventTitle: 'Actor Start',
                eventDescription: 'Actor start event',
                isOneTimeEvent: true,
                eventTieredPricingUsd: {
                    FREE: { tieredEventPriceUsd: 0.0005 },
                    BRONZE: { tieredEventPriceUsd: 0.00047 },
                    SILVER: { tieredEventPriceUsd: 0.00043 },
                    GOLD: { tieredEventPriceUsd: 0.0004 },
                    PLATINUM: { tieredEventPriceUsd: 0.0004 },
                    DIAMOND: { tieredEventPriceUsd: 0.0004 },
                },
            },
            'result-item': {
                eventTitle: 'Each tweet. Cheaper for higher plans',
                eventDescription: 'Each tweet. Cheaper for higher plans to avoid abusers.',
                isPrimaryEvent: true,
                isOneTimeEvent: false,
                eventTieredPricingUsd: {
                    FREE: { tieredEventPriceUsd: 0.005 },
                    BRONZE: { tieredEventPriceUsd: 0.0008 },
                    SILVER: { tieredEventPriceUsd: 0.0006 },
                    GOLD: { tieredEventPriceUsd: 0.00025 },
                    PLATINUM: { tieredEventPriceUsd: 0.00025 },
                    DIAMOND: { tieredEventPriceUsd: 0.00025 },
                },
            },
        },
    },
} as unknown as PricingInfo;

const twitterXScraperStoreActor = {
    id: 'twitter-x-scraper',
    name: 'twitter-x-scraper',
    username: 'xtdata',
    title: 'X.com Twitter API Scraper',
    description: 'Scrape Twitter (X) data efficiently.',
    isDeprecated: false,
    modifiedAt: new Date('2026-05-03T11:04:10.172Z'),
    categories: ['SOCIAL_MEDIA'],
    actorReviewRating: 3.4,
    actorReviewCount: 5,
    currentPricingInfo: twitterXScraperPricing,
    stats: {
        totalBuilds: 1,
        totalRuns: 1,
        totalUsers: 2400,
        totalUsers30Days: 177,
        actorReviewCount: 5,
        actorReviewRating: 3.4,
    },
} as unknown as ActorStoreList;

describe('formatPricing()', () => {
    it('formats PAY_PER_EVENT with a single event', () => {
        expect(
            formatPricing({
                model: 'PAY_PER_EVENT',
                events: [{ title: 'Each tweet', priceUsd: 0.00025 }],
            }),
        ).toBe('$0.25 / 1,000 each tweets');
    });

    it('uses the event flagged isPrimaryEvent when an actor has multiple charge events', () => {
        expect(
            formatPricing({
                model: 'PAY_PER_EVENT',
                events: [
                    { title: 'Actor start', priceUsd: 0.0004 },
                    { title: 'Each tweet', priceUsd: 0.00025, isPrimaryEvent: true },
                ],
            }),
        ).toBe('from $0.25 / 1,000 each tweets');
    });

    it('falls back to Pay per event when multi-event PPE has no primary event', () => {
        expect(
            formatPricing({
                model: 'PAY_PER_EVENT',
                events: [
                    { title: 'Actor Start', priceUsd: 0.0005 },
                    { title: 'Each tweet', priceUsd: 0.005 },
                ],
            }),
        ).toBe('Pay per event');
    });

    it('falls back to Pay per event when there are no events', () => {
        expect(formatPricing({ model: 'PAY_PER_EVENT', events: [] })).toBe('Pay per event');
        expect(formatPricing({ model: 'PAY_PER_EVENT' })).toBe('Pay per event');
    });

    it('matches public Store page for multi-event PPE with a primary event (#905)', () => {
        const widgetActor = formatActorForWidget(twitterXScraperStoreActor, 'FREE');

        expect(formatPricing(widgetActor.currentPricingInfo)).toBe(
            'from $0.25 / 1,000 each tweet. cheaper for higher plans',
        );
    });

    it('uses the true cheapest tier, not GOLD, when a higher tier is cheaper', () => {
        // compass/crawler-google-places-shaped: price decreases monotonically per tier,
        // DIAMOND ($0.76/1,000) is cheaper than GOLD ($2.10/1,000).
        const price = formatPricing({
            model: 'PAY_PER_EVENT',
            events: [
                {
                    title: 'Scraped place',
                    tieredPricing: [
                        { tier: 'FREE', priceUsd: 0.004 },
                        { tier: 'BRONZE', priceUsd: 0.004 },
                        { tier: 'SILVER', priceUsd: 0.003 },
                        { tier: 'GOLD', priceUsd: 0.0021 },
                        { tier: 'PLATINUM', priceUsd: 0.00126 },
                        { tier: 'DIAMOND', priceUsd: 0.00076 },
                    ],
                },
            ],
        });

        expect(price).toBe('from $0.76 / 1,000 scraped places');
    });
});
