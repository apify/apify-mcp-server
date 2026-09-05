import { describe, expect, it } from 'vitest';

import { ACTOR_PRICING_MODEL } from '../../src/const.js';
import type { ActorStoreList } from '../../src/types.js';
import { formatActorForWidget } from '../../src/utils/actor_card.js';
import type { PricingInfo } from '../../src/utils/pricing_info.js';
import { formatPricing } from '../../src/web/src/utils/formatting.js';

/**
 * Mirrors xtdata/twitter-x-scraper live PAY_PER_EVENT pricing (apify/apify-mcp-server#905).
 * Store badge: "from $0.25 / 1,000 each tweet. cheaper for higher plans" (GOLD = Business plan).
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
    currentPricingInfo: twitterXScraperPricing,
    stats: { totalUsers: 2400, actorReviewCount: 5, actorReviewRating: 3.4 },
} as unknown as ActorStoreList;

describe('formatPricing()', () => {
    it('renders the primary event through the server pricing: own price plus the Store price (#905)', () => {
        // FREE user pays $0.005 per tweet; the Store advertises the GOLD price, $0.25 / 1,000.
        expect(formatPricing(formatActorForWidget(twitterXScraperStoreActor, 'FREE').currentPricingInfo)).toBe(
            '$5.00 / 1,000 each tweet. cheaper for higher plans · from $0.25 on paid plans',
        );
        // GOLD user already pays the advertised price: no hint.
        expect(formatPricing(formatActorForWidget(twitterXScraperStoreActor, 'GOLD').currentPricingInfo)).toBe(
            '$0.25 / 1,000 each tweet. cheaper for higher plans',
        );
    });

    it('quotes repeatable events per 1,000, like the Store, whatever the unit price', () => {
        expect(formatPricing({ model: 'PAY_PER_EVENT', events: [{ title: 'Result', priceUsd: 0.00025 }] })).toBe(
            '$0.25 / 1,000 results',
        );
        expect(
            formatPricing({ model: 'PAY_PER_EVENT', events: [{ title: 'Competitor analysis', priceUsd: 0.05 }] }),
        ).toBe('$50.00 / 1,000 competitor analyses');
    });

    it('quotes one-time events per run', () => {
        expect(
            formatPricing({
                model: 'PAY_PER_EVENT',
                events: [{ title: 'Actor start', priceUsd: 0.0005, isOneTimeEvent: true, paidPlanPriceUsd: 0.0004 }],
            }),
        ).toBe('$0.0005 per run · from $0.0004 on paid plans');
    });

    it('keeps sub-cent per-1,000 prices precise instead of rounding to $0.00', () => {
        expect(formatPricing({ model: 'PAY_PER_EVENT', events: [{ title: 'Review', priceUsd: 0.0000945 }] })).toBe(
            '$0.0945 / 1,000 reviews',
        );
    });

    it('uses the event flagged isPrimaryEvent when an Actor has several events', () => {
        expect(
            formatPricing({
                model: 'PAY_PER_EVENT',
                events: [
                    { title: 'Actor start', priceUsd: 0.0004, isOneTimeEvent: true },
                    {
                        title: 'Each tweet. Cheaper for higher plans',
                        priceUsd: 0.005,
                        isPrimaryEvent: true,
                        paidPlanPriceUsd: 0.00025,
                    },
                ],
            }),
        ).toBe('$5.00 / 1,000 each tweet. cheaper for higher plans · from $0.25 on paid plans');
    });

    it('falls back to Pay per event without a primary event, events, or a price', () => {
        expect(
            formatPricing({
                model: 'PAY_PER_EVENT',
                events: [
                    { title: 'Actor Start', priceUsd: 0.0005 },
                    { title: 'Each tweet', priceUsd: 0.005 },
                ],
            }),
        ).toBe('Pay per event');
        expect(formatPricing({ model: 'PAY_PER_EVENT', events: [] })).toBe('Pay per event');
        expect(formatPricing({ model: 'PAY_PER_EVENT' })).toBe('Pay per event');
        expect(formatPricing({ model: 'PAY_PER_EVENT', events: [{ title: 'Result' }] })).toBe('Pay per event');
    });

    it('renders a $0 price as $0.00', () => {
        expect(formatPricing({ model: 'PAY_PER_EVENT', events: [{ title: 'Result', priceUsd: 0 }] })).toBe(
            '$0.00 / 1,000 results',
        );
    });

    it('formats PRICE_PER_DATASET_ITEM per 1,000 with the paid-plan hint when the server sets one', () => {
        expect(
            formatPricing({
                model: 'PRICE_PER_DATASET_ITEM',
                unitName: 'result',
                pricePerUnit: 0.004,
                paidPlanPricePerUnit: 0.0015,
            }),
        ).toBe('$4.00 / 1,000 results · from $1.50 on paid plans');
        expect(formatPricing({ model: 'PRICE_PER_DATASET_ITEM', unitName: 'page', pricePerUnit: 0.002 })).toBe(
            '$2.00 / 1,000 pages',
        );
    });

    it('formats FLAT_PRICE_PER_MONTH with the paid-plan hint when the server sets one', () => {
        expect(
            formatPricing({
                model: 'FLAT_PRICE_PER_MONTH',
                pricePerUnit: 30,
                trialMinutes: 0,
                paidPlanPricePerUnit: 20,
            }),
        ).toBe('$30.00/month + usage · from $20.00 on paid plans');
        expect(formatPricing({ model: 'FLAT_PRICE_PER_MONTH', pricePerUnit: 30 })).toBe('$30.00/month + usage');
    });
});
