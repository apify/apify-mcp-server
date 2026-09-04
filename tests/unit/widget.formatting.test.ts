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
                events: [{ title: 'Result', priceUsd: 0.00025 }],
            }),
        ).toBe('$0.25 / 1,000 results');
    });

    it('uses the event flagged isPrimaryEvent when an actor has multiple charge events', () => {
        // The Store pluralizes the last word of the title; "plans" is already plural.
        expect(
            formatPricing({
                model: 'PAY_PER_EVENT',
                events: [
                    { title: 'Actor start', priceUsd: 0.0004 },
                    { title: 'Each tweet. Cheaper for higher plans', priceUsd: 0.00025, isPrimaryEvent: true },
                ],
            }),
        ).toBe('from $0.25 / 1,000 each tweet. cheaper for higher plans');
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

    it('prices the badge at the GOLD tier, not the cheapest tier (#905)', () => {
        // compass/crawler-google-places real tiers. DIAMOND is $0.76 / 1,000, yet the Store
        // badge shows "from $1.50 / 1,000 scraped places" — GOLD is the best tier listed on
        // apify.com/pricing; PLATINUM/DIAMOND are enterprise-only and never shown.
        const price = formatPricing({
            model: 'PAY_PER_EVENT',
            events: [
                {
                    title: 'Scraped place',
                    tieredPricing: [
                        { tier: 'FREE', priceUsd: 0.004 },
                        { tier: 'BRONZE', priceUsd: 0.003 },
                        { tier: 'SILVER', priceUsd: 0.002 },
                        { tier: 'GOLD', priceUsd: 0.0015 },
                        { tier: 'PLATINUM', priceUsd: 0.00126 },
                        { tier: 'DIAMOND', priceUsd: 0.000756 },
                    ],
                },
            ],
        });

        expect(price).toBe('from $1.50 / 1,000 scraped places');
    });

    it('shows "from" for a single tiered event and prices it at GOLD', () => {
        // apify/instagram-scraper real tiers. Store badge: "from $1.50 / 1,000 results".
        const price = formatPricing({
            model: 'PAY_PER_EVENT',
            events: [
                {
                    title: 'Result',
                    tieredPricing: [
                        { tier: 'FREE', priceUsd: 0.0027 },
                        { tier: 'BRONZE', priceUsd: 0.0023 },
                        { tier: 'SILVER', priceUsd: 0.0019 },
                        { tier: 'GOLD', priceUsd: 0.0015 },
                        { tier: 'PLATINUM', priceUsd: 0.0009 },
                        { tier: 'DIAMOND', priceUsd: 0.0005 },
                    ],
                },
            ],
        });

        expect(price).toBe('from $1.50 / 1,000 results');
    });

    it('matches the Store page for a multi-event Actor whose GOLD price is above its cheapest tier', () => {
        // xtdata/tiktok-user-information-scraper real tiers (from the live widget payload).
        // Store badge: "from $6.80 / 1,000 user queries" — GOLD, not the $6.00 DIAMOND tier.
        const price = formatPricing({
            model: 'PAY_PER_EVENT',
            events: [
                {
                    title: 'Actor Start',
                    tieredPricing: [
                        { tier: 'FREE', priceUsd: 0.006 },
                        { tier: 'BRONZE', priceUsd: 0.0056 },
                        { tier: 'SILVER', priceUsd: 0.0052 },
                        { tier: 'GOLD', priceUsd: 0.0048 },
                        { tier: 'PLATINUM', priceUsd: 0.0044 },
                        { tier: 'DIAMOND', priceUsd: 0.004 },
                    ],
                },
                {
                    title: 'User query',
                    isPrimaryEvent: true,
                    tieredPricing: [
                        { tier: 'FREE', priceUsd: 0.008 },
                        { tier: 'BRONZE', priceUsd: 0.0076 },
                        { tier: 'SILVER', priceUsd: 0.0072 },
                        { tier: 'GOLD', priceUsd: 0.0068 },
                        { tier: 'PLATINUM', priceUsd: 0.0064 },
                        { tier: 'DIAMOND', priceUsd: 0.006 },
                    ],
                },
            ],
        });

        expect(price).toBe('from $6.80 / 1,000 user queries');
    });

    it('falls back to the cheapest paid tier when GOLD is missing', () => {
        const price = formatPricing({
            model: 'PAY_PER_EVENT',
            events: [
                {
                    title: 'Result',
                    tieredPricing: [
                        { tier: 'FREE', priceUsd: 0.004 },
                        { tier: 'BRONZE', priceUsd: 0.003 },
                        { tier: 'SILVER', priceUsd: 0.002 },
                    ],
                },
            ],
        });

        expect(price).toBe('from $2.00 / 1,000 results');
    });

    it('prices tiered PRICE_PER_DATASET_ITEM at GOLD like the PAY_PER_EVENT badge', () => {
        const price = formatPricing({
            model: 'PRICE_PER_DATASET_ITEM',
            unitName: 'result',
            pricePerUnit: 0.004,
            tieredPricing: [
                { tier: 'FREE', pricePerUnit: 0.004 },
                { tier: 'GOLD', pricePerUnit: 0.0015 },
                { tier: 'DIAMOND', pricePerUnit: 0.0005 },
            ],
        });

        expect(price).toBe('from $1.50 / 1,000 results');
    });

    it('prices tiered FLAT_PRICE_PER_MONTH at GOLD instead of the un-resolved base price', () => {
        // Complete mode carries the base `pricePerUnit` (30) untouched; the badge must resolve the tier.
        const price = formatPricing({
            model: 'FLAT_PRICE_PER_MONTH',
            pricePerUnit: 30,
            trialMinutes: 0,
            tieredPricing: [
                { tier: 'FREE', pricePerUnit: 30 },
                { tier: 'GOLD', pricePerUnit: 20 },
            ],
        });

        expect(price).toBe('$20.00/month + usage');
    });

    it('falls back to the flat price when no paid tier exists', () => {
        expect(
            formatPricing({
                model: 'PAY_PER_EVENT',
                events: [{ title: 'Result', priceUsd: 0.002, tieredPricing: [{ tier: 'FREE', priceUsd: 0.002 }] }],
            }),
        ).toBe('$2.00 / 1,000 results');
    });

    it('returns Pay per event when neither a paid tier nor a flat price exists', () => {
        expect(
            formatPricing({
                model: 'PAY_PER_EVENT',
                events: [{ title: 'Result', tieredPricing: [{ tier: 'FREE', priceUsd: 0 }] }],
            }),
        ).toBe('Pay per event');
    });

    it('prices an event at or above $0.01 per event, with "from" only when other events exist', () => {
        const analysis = { title: 'Competitor analysis', priceUsd: 0.05 };

        expect(formatPricing({ model: 'PAY_PER_EVENT', events: [analysis] })).toBe('$0.05 / competitor analysis');
        expect(
            formatPricing({
                model: 'PAY_PER_EVENT',
                events: [
                    { title: 'Actor start', priceUsd: 0.0001 },
                    { ...analysis, isPrimaryEvent: true },
                ],
            }),
        ).toBe('from $0.05 / competitor analysis');
    });

    it('formats FLAT_PRICE_PER_MONTH without tiers from the base price', () => {
        expect(formatPricing({ model: 'FLAT_PRICE_PER_MONTH', pricePerUnit: 30 })).toBe('$30.00/month + usage');
    });
});
