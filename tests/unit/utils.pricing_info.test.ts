import { describe, expect, it } from 'vitest';

import { ACTOR_PRICING_MODEL } from '../../src/const.js';
import {
    type PricingInfo,
    pricingInfoToSimplifiedString,
    pricingInfoToSimplifiedStructured,
    pricingInfoToString,
    pricingInfoToStructured,
} from '../../src/utils/pricing_info.js';

// Fixtures: shape mirrors the Apify API raw data (see src/utils/pricing_info.ts types).
// E1–E8 below are the worked-example oracle for the two output modes: complete
// (fetch-actor-details) and simplified (search-actors).

// E1/E2/E3: compass/crawler-google-places — PAY_PER_EVENT, multi-tier "Scraped place" event,
// flat one-time "Actor start" event.
const multiTierPayPerEvent = {
    pricingModel: ACTOR_PRICING_MODEL.PAY_PER_EVENT,
    pricingPerEvent: {
        actorChargeEvents: {
            scraped: {
                eventTitle: 'Scraped place',
                eventDescription: 'A Google Maps place scraped',
                eventTieredPricingUsd: {
                    FREE: { tieredEventPriceUsd: 0.004 },
                    BRONZE: { tieredEventPriceUsd: 0.004 },
                    SILVER: { tieredEventPriceUsd: 0.003 },
                    GOLD: { tieredEventPriceUsd: 0.0021 },
                    PLATINUM: { tieredEventPriceUsd: 0.00126 },
                    DIAMOND: { tieredEventPriceUsd: 0.00076 },
                },
            },
            start: {
                eventTitle: 'Actor start',
                eventDescription: 'Initial fee for starting the Actor',
                eventPriceUsd: 0.00005,
                isOneTimeEvent: true,
            },
        },
    },
} as unknown as PricingInfo;

const mixedTierPayPerEvent = {
    pricingModel: ACTOR_PRICING_MODEL.PAY_PER_EVENT,
    pricingPerEvent: {
        actorChargeEvents: {
            a: {
                eventTitle: 'A',
                eventDescription: '',
                eventTieredPricingUsd: {
                    FREE: { tieredEventPriceUsd: 0.01 },
                    GOLD: { tieredEventPriceUsd: 0.005 },
                },
            },
            b: {
                eventTitle: 'B',
                eventDescription: '',
                eventTieredPricingUsd: {
                    FREE: { tieredEventPriceUsd: 0.02 },
                    BRONZE: { tieredEventPriceUsd: 0.015 },
                },
            },
        },
    },
} as unknown as PricingInfo;

const longPayPerEvent = {
    pricingModel: ACTOR_PRICING_MODEL.PAY_PER_EVENT,
    pricingPerEvent: {
        actorChargeEvents: {
            a: {
                eventTitle: 'Result',
                eventDescription: 'Cost per result returned.',
                eventTieredPricingUsd: { FREE: { tieredEventPriceUsd: 0.0037 } },
            },
            b: {
                eventTitle: 'Add-on: Date filter',
                eventDescription: 'Extra cost when date filtering is used.',
                eventTieredPricingUsd: { FREE: { tieredEventPriceUsd: 0.0013 } },
            },
            c: {
                eventTitle: 'Add-on: Popularity filter',
                eventDescription: 'Extra cost when filtering by popularity is used.',
                eventTieredPricingUsd: { FREE: { tieredEventPriceUsd: 0.0013 } },
            },
            d: {
                eventTitle: 'Add-on: Follower / Following',
                eventDescription: 'Extra cost per follower / following profile returned.',
                eventTieredPricingUsd: { FREE: { tieredEventPriceUsd: 0.004 } },
            },
            e: {
                eventTitle: 'Add-on: Search video sorting',
                eventDescription: 'Extra cost for scraping the sorted videos.',
                eventTieredPricingUsd: { FREE: { tieredEventPriceUsd: 0.0013 } },
            },
            f: {
                eventTitle: 'Actor start',
                eventDescription: 'Flat fee for starting an Actor run.',
                isOneTimeEvent: true,
                eventTieredPricingUsd: { FREE: { tieredEventPriceUsd: 0.001 } },
            },
        },
    },
} as unknown as PricingInfo;

// E9: twitter-x-scraper-shaped — one-time Actor start + per-tweet result event flagged isPrimaryEvent.
const primaryFlaggedPayPerEvent = {
    pricingModel: ACTOR_PRICING_MODEL.PAY_PER_EVENT,
    pricingPerEvent: {
        actorChargeEvents: {
            start: {
                eventTitle: 'Actor start',
                eventDescription: 'Actor start event',
                eventPriceUsd: 0.0004,
                isOneTimeEvent: true,
            },
            'result-item': {
                eventTitle: 'Each tweet',
                eventDescription: 'Each tweet',
                eventPriceUsd: 0.00025,
                isPrimaryEvent: true,
            },
        },
    },
} as unknown as PricingInfo;

// E4: single-tier actor — raw data has only one bucket.
const singleTierPayPerEvent = {
    pricingModel: ACTOR_PRICING_MODEL.PAY_PER_EVENT,
    pricingPerEvent: {
        actorChargeEvents: {
            scraped: {
                eventTitle: 'Scraped place',
                eventDescription: 'A Google Maps place scraped',
                eventTieredPricingUsd: {
                    FREE: { tieredEventPriceUsd: 0.004 },
                },
            },
        },
    },
} as unknown as PricingInfo;

// E5/E6: PRICE_PER_DATASET_ITEM with multi-tier pricing.
const multiTierDatasetItem = {
    pricingModel: ACTOR_PRICING_MODEL.PRICE_PER_DATASET_ITEM,
    pricePerUnitUsd: 0.005,
    unitName: 'result',
    tieredPricing: {
        FREE: { tieredPricePerUnitUsd: 0.005 },
        BRONZE: { tieredPricePerUnitUsd: 0.004 },
        GOLD: { tieredPricePerUnitUsd: 0.002 },
    },
} as unknown as PricingInfo;

// E7: FLAT_PRICE_PER_MONTH with multi-tier pricing, 7-day trial.
const multiTierRental = {
    pricingModel: ACTOR_PRICING_MODEL.FLAT_PRICE_PER_MONTH,
    pricePerUnitUsd: 30,
    trialMinutes: 60 * 24 * 7,
    tieredPricing: {
        FREE: { tieredPricePerUnitUsd: 30 },
        GOLD: { tieredPricePerUnitUsd: 20 },
    },
} as unknown as PricingInfo;

const freeActor = { pricingModel: ACTOR_PRICING_MODEL.FREE } as PricingInfo;

// A Business (GOLD) user already pays the Store's advertised price, so the note carries no "from" clause.
const NOTE_GOLD = 'Prices shown are for the Business plan. Use fetch-actor-details for the full pricing table.';
// A Free user sees the Store's advertised price (GOLD, else the cheapest paid tier) as the "from" clause.
const NOTE_FREE =
    'Prices shown are for the Free plan. Paid plans from $4.00 / 1,000 results. ' +
    'Use fetch-actor-details for the full pricing table.';
const EVENT_DESCRIPTIONS_OMITTED_NOTE =
    'Event descriptions were omitted because this actor has many pricing events. ' +
    'Use fetch-actor-details for full pricing details.';

// ─── Complete mode: fetch-actor-details ───────────────────────────────────────

describe('pricingInfoToStructured (complete mode)', () => {
    it('E1: PAY_PER_EVENT multi-tier preserves full matrix, includes userTier, no pricingNote', () => {
        expect(pricingInfoToStructured(multiTierPayPerEvent, 'GOLD')).toEqual({
            model: 'PAY_PER_EVENT',
            userTier: 'GOLD',
            events: [
                {
                    title: 'Scraped place',
                    description: 'A Google Maps place scraped',
                    priceUsd: undefined,
                    tieredPricing: [
                        { tier: 'FREE', priceUsd: 0.004 },
                        { tier: 'BRONZE', priceUsd: 0.004 },
                        { tier: 'SILVER', priceUsd: 0.003 },
                        { tier: 'GOLD', priceUsd: 0.0021 },
                        { tier: 'PLATINUM', priceUsd: 0.00126 },
                        { tier: 'DIAMOND', priceUsd: 0.00076 },
                    ],
                },
                {
                    title: 'Actor start',
                    description: 'Initial fee for starting the Actor',
                    priceUsd: 0.00005,
                    tieredPricing: undefined,
                    isOneTimeEvent: true,
                },
            ],
        });
    });

    it('E4: single-tier actor preserves the 1-element tieredPricing array, no pricingNote', () => {
        expect(pricingInfoToStructured(singleTierPayPerEvent, 'GOLD')).toEqual({
            model: 'PAY_PER_EVENT',
            userTier: 'GOLD',
            events: [
                {
                    title: 'Scraped place',
                    description: 'A Google Maps place scraped',
                    priceUsd: undefined,
                    tieredPricing: [{ tier: 'FREE', priceUsd: 0.004 }],
                },
            ],
        });
    });

    it('E9: PAY_PER_EVENT passes isPrimaryEvent and isOneTimeEvent through per event', () => {
        expect(pricingInfoToStructured(primaryFlaggedPayPerEvent, 'GOLD')).toEqual({
            model: 'PAY_PER_EVENT',
            userTier: 'GOLD',
            events: [
                {
                    title: 'Actor start',
                    description: 'Actor start event',
                    priceUsd: 0.0004,
                    tieredPricing: undefined,
                    isOneTimeEvent: true,
                },
                {
                    title: 'Each tweet',
                    description: 'Each tweet',
                    priceUsd: 0.00025,
                    tieredPricing: undefined,
                    isPrimaryEvent: true,
                },
            ],
        });
    });

    it('E5: PRICE_PER_DATASET_ITEM preserves full tiered matrix', () => {
        expect(pricingInfoToStructured(multiTierDatasetItem, 'GOLD')).toEqual({
            model: 'PRICE_PER_DATASET_ITEM',
            userTier: 'GOLD',
            pricePerUnit: 0.005,
            unitName: 'result',
            tieredPricing: [
                { tier: 'FREE', pricePerUnit: 0.005 },
                { tier: 'BRONZE', pricePerUnit: 0.004 },
                { tier: 'GOLD', pricePerUnit: 0.002 },
            ],
        });
    });

    it('E8: FREE actor returns the minimal shape + userTier', () => {
        expect(pricingInfoToStructured(freeActor, 'GOLD')).toEqual({
            model: 'FREE',
            userTier: 'GOLD',
        });
        expect(pricingInfoToStructured(null, 'FREE')).toEqual({
            model: 'FREE',
            userTier: 'FREE',
        });
    });
});

describe('pricingInfoToString (complete mode)', () => {
    it('E1: PAY_PER_EVENT lists all plans per 1,000 events for tiered events, per run for one-time events', () => {
        expect(pricingInfoToString(multiTierPayPerEvent)).toBe(
            'This Actor is paid per event:\n' +
                '  - **Scraped place**: A Google Maps place scraped ' +
                '(Free: $4.00, Starter: $4.00, Scale: $3.00, ' +
                'Business: $2.10, Platinum: $1.26, Diamond: $0.76 / 1,000 events)\n' +
                '  - **Actor start**: Initial fee for starting the Actor ($0.00005 per run)',
        );
    });

    it('E4: single-tier event renders as a flat price (no plan label)', () => {
        expect(pricingInfoToString(singleTierPayPerEvent)).toBe(
            'This Actor is paid per event:\n  - **Scraped place**: A Google Maps place scraped ($4.00 / 1,000 events)',
        );
    });

    it('E5: PRICE_PER_DATASET_ITEM lists all plans per 1,000 results', () => {
        expect(pricingInfoToString(multiTierDatasetItem)).toBe(
            'This Actor has tiered pricing: Free: $5.00, Starter: $4.00, Business: $2.00 / 1,000 results.',
        );
    });

    it('E7: FLAT_PRICE_PER_MONTH lists all plans per month', () => {
        expect(pricingInfoToString(multiTierRental)).toBe(
            'This Actor is rental and has tiered pricing: Free: $30.00, Business: $20.00 per month, ' +
                'with a trial period of 7 days.',
        );
    });

    it('prints an unknown tier code as is', () => {
        const info = {
            pricingModel: ACTOR_PRICING_MODEL.PRICE_PER_DATASET_ITEM,
            pricePerUnitUsd: 0.005,
            unitName: 'result',
            tieredPricing: {
                FREE: { tieredPricePerUnitUsd: 0.005 },
                TITANIUM: { tieredPricePerUnitUsd: 0.003 },
            },
        } as unknown as PricingInfo;
        expect(pricingInfoToString(info)).toBe(
            'This Actor has tiered pricing: Free: $5.00, TITANIUM: $3.00 / 1,000 results.',
        );
    });

    it('E8: FREE actor', () => {
        expect(pricingInfoToString(freeActor)).toBe(
            'This Actor is free to use. You are only charged for Apify platform usage.',
        );
        expect(pricingInfoToString(null)).toBe(
            'This Actor is free to use. You are only charged for Apify platform usage.',
        );
    });
});

// ─── Simplified mode: search-actors ───────────────────────────────────────────

describe('pricingInfoToSimplifiedStructured (simplified mode)', () => {
    it('E2: user on GOLD — resolved price reflects GOLD, pricingNote names the Business plan', () => {
        expect(pricingInfoToSimplifiedStructured(multiTierPayPerEvent, 'GOLD')).toEqual({
            model: 'PAY_PER_EVENT',
            events: [
                {
                    title: 'Scraped place',
                    description: 'A Google Maps place scraped',
                    priceUsd: 0.0021,
                },
                {
                    title: 'Actor start',
                    description: 'Initial fee for starting the Actor',
                    priceUsd: 0.00005,
                    isOneTimeEvent: true,
                },
            ],
            pricingNote: NOTE_GOLD,
        });
    });

    it('FREE user — note names the Free plan and the advertised price; the advertised event carries paidPlanPriceUsd', () => {
        const out = pricingInfoToSimplifiedStructured(multiTierPayPerEvent, 'FREE');
        expect(out.events?.[0].priceUsd).toBe(0.004);
        expect(out.events?.[0].paidPlanPriceUsd).toBe(0.0021);
        expect(out.events?.[1].paidPlanPriceUsd).toBeUndefined();
        expect(out.pricingNote).toBe(
            'Prices shown are for the Free plan. Paid plans from $2.10 / 1,000 events (Scraped place). ' +
                'Use fetch-actor-details for the full pricing table.',
        );
    });

    it('takes the advertised price from the primary event when several events are tiered', () => {
        const info = {
            pricingModel: ACTOR_PRICING_MODEL.PAY_PER_EVENT,
            pricingPerEvent: {
                actorChargeEvents: {
                    start: {
                        eventTitle: 'Actor start',
                        eventDescription: '',
                        isOneTimeEvent: true,
                        eventTieredPricingUsd: {
                            FREE: { tieredEventPriceUsd: 0.0005 },
                            GOLD: { tieredEventPriceUsd: 0.0004 },
                        },
                    },
                    tweet: {
                        eventTitle: 'Each tweet',
                        eventDescription: '',
                        isPrimaryEvent: true,
                        eventTieredPricingUsd: {
                            FREE: { tieredEventPriceUsd: 0.005 },
                            GOLD: { tieredEventPriceUsd: 0.00025 },
                        },
                    },
                },
            },
        } as unknown as PricingInfo;
        const out = pricingInfoToSimplifiedStructured(info, 'FREE');
        expect(out.pricingNote).toBe(
            'Prices shown are for the Free plan. Paid plans from $0.25 / 1,000 events (Each tweet). ' +
                'Use fetch-actor-details for the full pricing table.',
        );
        expect(out.events?.map((event) => event.paidPlanPriceUsd)).toEqual([undefined, 0.00025]);
    });

    it('E3: user on DIAMOND, actor offers only FREE and BRONZE — resolves to the FREE price, hints BRONZE', () => {
        const info = {
            pricingModel: ACTOR_PRICING_MODEL.PRICE_PER_DATASET_ITEM,
            pricePerUnitUsd: 0.005,
            unitName: 'result',
            tieredPricing: {
                FREE: { tieredPricePerUnitUsd: 0.005 },
                BRONZE: { tieredPricePerUnitUsd: 0.004 },
            },
        } as unknown as PricingInfo;
        expect(pricingInfoToSimplifiedStructured(info, 'DIAMOND')).toEqual({
            model: 'PRICE_PER_DATASET_ITEM',
            pricePerUnit: 0.005,
            unitName: 'result',
            paidPlanPricePerUnit: 0.004,
            pricingNote: NOTE_FREE,
        });
    });

    it('resolves to the first entry when neither user tier nor FREE exist; omits the tieredPricing array', () => {
        const info = {
            pricingModel: ACTOR_PRICING_MODEL.PRICE_PER_DATASET_ITEM,
            pricePerUnitUsd: 0.005,
            unitName: 'result',
            tieredPricing: {
                BRONZE: { tieredPricePerUnitUsd: 0.004 },
                SILVER: { tieredPricePerUnitUsd: 0.003 },
            },
        } as unknown as PricingInfo;
        const out = pricingInfoToSimplifiedStructured(info, 'DIAMOND');
        expect(out.pricePerUnit).toBe(0.004);
        expect(out.paidPlanPricePerUnit).toBe(0.003);
        expect(out.pricingNote).toBe(
            'Prices shown are for the Starter plan. Paid plans from $3.00 / 1,000 results. ' +
                'Use fetch-actor-details for the full pricing table.',
        );
        expect(out.tieredPricing).toBeUndefined();
        expect(out.userTier).toBeUndefined();
    });

    it('E4: single-tier actor — no pricingNote (nothing to compare against)', () => {
        expect(pricingInfoToSimplifiedStructured(singleTierPayPerEvent, 'GOLD')).toEqual({
            model: 'PAY_PER_EVENT',
            events: [
                {
                    title: 'Scraped place',
                    description: 'A Google Maps place scraped',
                    priceUsd: 0.004,
                },
            ],
        });
    });

    it('E9: PAY_PER_EVENT simplified passes isPrimaryEvent and isOneTimeEvent through per event', () => {
        expect(pricingInfoToSimplifiedStructured(primaryFlaggedPayPerEvent, 'GOLD')).toEqual({
            model: 'PAY_PER_EVENT',
            events: [
                {
                    title: 'Actor start',
                    description: 'Actor start event',
                    priceUsd: 0.0004,
                    isOneTimeEvent: true,
                },
                {
                    title: 'Each tweet',
                    description: 'Each tweet',
                    priceUsd: 0.00025,
                    isPrimaryEvent: true,
                },
            ],
        });
    });

    it('E6: PRICE_PER_DATASET_ITEM simplified — top-level pricePerUnit reflects resolved tier', () => {
        expect(pricingInfoToSimplifiedStructured(multiTierDatasetItem, 'GOLD')).toEqual({
            model: 'PRICE_PER_DATASET_ITEM',
            pricePerUnit: 0.002,
            unitName: 'result',
            pricingNote: NOTE_GOLD,
        });
    });

    it('user on DIAMOND — resolved price is DIAMOND, no hint, pricingNote is suppressed (top tier)', () => {
        const info = {
            pricingModel: ACTOR_PRICING_MODEL.PRICE_PER_DATASET_ITEM,
            pricePerUnitUsd: 0.005,
            unitName: 'result',
            tieredPricing: {
                FREE: { tieredPricePerUnitUsd: 0.005 },
                GOLD: { tieredPricePerUnitUsd: 0.002 },
                DIAMOND: { tieredPricePerUnitUsd: 0.001 },
            },
        } as unknown as PricingInfo;
        const out = pricingInfoToSimplifiedStructured(info, 'DIAMOND');
        expect(out.pricePerUnit).toBe(0.001);
        expect(out.paidPlanPricePerUnit).toBeUndefined();
        expect(out.pricingNote).toBeUndefined();
        expect(out.tieredPricing).toBeUndefined();
    });

    it('E7: FLAT_PRICE_PER_MONTH simplified includes trialMinutes + resolved tier price', () => {
        expect(pricingInfoToSimplifiedStructured(multiTierRental, 'GOLD')).toEqual({
            model: 'FLAT_PRICE_PER_MONTH',
            pricePerUnit: 20,
            trialMinutes: 60 * 24 * 7,
            pricingNote: NOTE_GOLD,
        });
    });

    it('E8: FREE actor — minimal shape, no userTier in simplified mode', () => {
        expect(pricingInfoToSimplifiedStructured(freeActor, 'GOLD')).toEqual({
            model: 'FREE',
        });
    });

    it('omits pricingNote when PAY_PER_EVENT events resolve to different tiers', () => {
        expect(pricingInfoToSimplifiedStructured(mixedTierPayPerEvent, 'GOLD')).toEqual({
            model: 'PAY_PER_EVENT',
            events: [
                {
                    title: 'A',
                    description: '',
                    priceUsd: 0.005,
                },
                {
                    title: 'B',
                    description: '',
                    priceUsd: 0.02,
                },
            ],
        });
    });

    it('omits event descriptions and adds omission metadata when PAY_PER_EVENT has more than 5 events (single-tier: no pricingNote)', () => {
        expect(pricingInfoToSimplifiedStructured(longPayPerEvent, 'FREE')).toEqual({
            model: 'PAY_PER_EVENT',
            events: [
                { title: 'Result', priceUsd: 0.0037 },
                { title: 'Add-on: Date filter', priceUsd: 0.0013 },
                { title: 'Add-on: Popularity filter', priceUsd: 0.0013 },
                { title: 'Add-on: Follower / Following', priceUsd: 0.004 },
                { title: 'Add-on: Search video sorting', priceUsd: 0.0013 },
                { title: 'Actor start', priceUsd: 0.001, isOneTimeEvent: true },
            ],
            eventDescriptionsOmitted: true,
            eventDescriptionsNote: EVENT_DESCRIPTIONS_OMITTED_NOTE,
        });
    });
});

describe('pricingNote edge cases', () => {
    it('never hints a top-tier user, even when a developer priced a lower tier below DIAMOND', () => {
        const info = {
            pricingModel: ACTOR_PRICING_MODEL.PRICE_PER_DATASET_ITEM,
            pricePerUnitUsd: 0.005,
            unitName: 'result',
            tieredPricing: {
                FREE: { tieredPricePerUnitUsd: 0.005 },
                GOLD: { tieredPricePerUnitUsd: 0.001 },
                DIAMOND: { tieredPricePerUnitUsd: 0.002 },
            },
        } as unknown as PricingInfo;
        const out = pricingInfoToSimplifiedStructured(info, 'DIAMOND');
        expect(out.pricePerUnit).toBe(0.002);
        expect(out.paidPlanPricePerUnit).toBeUndefined();
        expect(out.pricingNote).toBeUndefined();
    });

    it('omits the event title from the note when the Actor has a single event', () => {
        const info = {
            pricingModel: ACTOR_PRICING_MODEL.PAY_PER_EVENT,
            pricingPerEvent: {
                actorChargeEvents: {
                    result: {
                        eventTitle: 'Result',
                        eventDescription: '',
                        eventTieredPricingUsd: {
                            FREE: { tieredEventPriceUsd: 0.0027 },
                            GOLD: { tieredEventPriceUsd: 0.0015 },
                        },
                    },
                },
            },
        } as unknown as PricingInfo;
        const out = pricingInfoToSimplifiedStructured(info, 'FREE');
        expect(out.events?.[0].paidPlanPriceUsd).toBe(0.0015);
        expect(out.pricingNote).toBe(
            'Prices shown are for the Free plan. Paid plans from $1.50 / 1,000 events. ' +
                'Use fetch-actor-details for the full pricing table.',
        );
    });

    it('keeps the paid-plan price on the primary event when descriptions are trimmed (more than 5 events)', () => {
        const addOn = (title: string) => ({
            eventTitle: title,
            eventDescription: 'Extra cost.',
            eventTieredPricingUsd: { FREE: { tieredEventPriceUsd: 0.001 } },
        });
        const info = {
            pricingModel: ACTOR_PRICING_MODEL.PAY_PER_EVENT,
            pricingPerEvent: {
                actorChargeEvents: {
                    result: {
                        eventTitle: 'Result',
                        eventDescription: 'Cost per result.',
                        isPrimaryEvent: true,
                        eventTieredPricingUsd: {
                            FREE: { tieredEventPriceUsd: 0.004 },
                            GOLD: { tieredEventPriceUsd: 0.0015 },
                        },
                    },
                    a: addOn('Add-on A'),
                    b: addOn('Add-on B'),
                    c: addOn('Add-on C'),
                    d: addOn('Add-on D'),
                    e: addOn('Add-on E'),
                },
            },
        } as unknown as PricingInfo;
        const out = pricingInfoToSimplifiedStructured(info, 'FREE');
        expect(out.eventDescriptionsOmitted).toBe(true);
        expect(out.events?.[0]).toEqual({
            title: 'Result',
            isPrimaryEvent: true,
            priceUsd: 0.004,
            paidPlanPriceUsd: 0.0015,
        });
        expect(out.pricingNote).toBe(
            'Prices shown are for the Free plan. Paid plans from $1.50 / 1,000 events (Result). ' +
                'Use fetch-actor-details for the full pricing table.',
        );
    });

    it('excludes a $0 paid tier from the advertised price, like the widget badge', () => {
        const info = {
            pricingModel: ACTOR_PRICING_MODEL.PRICE_PER_DATASET_ITEM,
            pricePerUnitUsd: 0.005,
            unitName: 'result',
            tieredPricing: {
                FREE: { tieredPricePerUnitUsd: 0.005 },
                BRONZE: { tieredPricePerUnitUsd: 0.004 },
                GOLD: { tieredPricePerUnitUsd: 0 },
            },
        } as unknown as PricingInfo;
        expect(pricingInfoToSimplifiedString(info, 'FREE')).toBe(
            'This Actor costs $5.00 / 1,000 results. Prices shown are for the Free plan. ' +
                'Paid plans from $4.00 / 1,000 results. Use fetch-actor-details for the full pricing table.',
        );
    });

    it('omits the "from" clause when several events are tiered and none is flagged primary', () => {
        const info = {
            pricingModel: ACTOR_PRICING_MODEL.PAY_PER_EVENT,
            pricingPerEvent: {
                actorChargeEvents: {
                    a: {
                        eventTitle: 'A',
                        eventDescription: '',
                        eventTieredPricingUsd: {
                            FREE: { tieredEventPriceUsd: 0.01 },
                            GOLD: { tieredEventPriceUsd: 0.005 },
                        },
                    },
                    b: {
                        eventTitle: 'B',
                        eventDescription: '',
                        eventTieredPricingUsd: {
                            FREE: { tieredEventPriceUsd: 0.02 },
                            GOLD: { tieredEventPriceUsd: 0.01 },
                        },
                    },
                },
            },
        } as unknown as PricingInfo;
        const out = pricingInfoToSimplifiedStructured(info, 'FREE');
        expect(out.pricingNote).toBe(
            'Prices shown are for the Free plan. Use fetch-actor-details for the full pricing table.',
        );
        expect(out.events?.map((event) => event.paidPlanPriceUsd)).toEqual([undefined, undefined]);
    });
});

describe('pricingInfoToSimplifiedString (simplified mode)', () => {
    it('E2: user on GOLD — one price per event, pricingNote appended', () => {
        expect(pricingInfoToSimplifiedString(multiTierPayPerEvent, 'GOLD')).toBe(
            `This Actor is paid per event:\n` +
                `  - **Scraped place**: A Google Maps place scraped ($2.10 / 1,000 events)\n` +
                `  - **Actor start**: Initial fee for starting the Actor ($0.00005 per run)\n${NOTE_GOLD}`,
        );
    });

    it('E4: single-tier actor — flat price, no pricingNote', () => {
        expect(pricingInfoToSimplifiedString(singleTierPayPerEvent, 'GOLD')).toBe(
            'This Actor is paid per event:\n  - **Scraped place**: A Google Maps place scraped ($4.00 / 1,000 events)',
        );
    });

    it('E6: PRICE_PER_DATASET_ITEM simplified — single price + note', () => {
        expect(pricingInfoToSimplifiedString(multiTierDatasetItem, 'GOLD')).toBe(
            `This Actor costs $2.00 / 1,000 results. ${NOTE_GOLD}`,
        );
    });

    it('E7: FLAT_PRICE_PER_MONTH simplified — rental price + trial + note', () => {
        expect(pricingInfoToSimplifiedString(multiTierRental, 'GOLD')).toBe(
            `This Actor is rental and costs $20.00 per month, with a trial period of 7 days. ${NOTE_GOLD}`,
        );
    });

    it('FREE user — note names the Free plan and the advertised paid-plan price per model', () => {
        expect(pricingInfoToSimplifiedString(multiTierDatasetItem, 'FREE')).toBe(
            'This Actor costs $5.00 / 1,000 results. Prices shown are for the Free plan. ' +
                'Paid plans from $2.00 / 1,000 results. Use fetch-actor-details for the full pricing table.',
        );
        expect(pricingInfoToSimplifiedString(multiTierRental, 'FREE')).toBe(
            'This Actor is rental and costs $30.00 per month, with a trial period of 7 days. ' +
                'Prices shown are for the Free plan. Paid plans from $20.00 per month. ' +
                'Use fetch-actor-details for the full pricing table.',
        );
        expect(pricingInfoToSimplifiedString(multiTierPayPerEvent, 'FREE')).toBe(
            'This Actor is paid per event:\n' +
                '  - **Scraped place**: A Google Maps place scraped ($4.00 / 1,000 events)\n' +
                '  - **Actor start**: Initial fee for starting the Actor ($0.00005 per run)\n' +
                'Prices shown are for the Free plan. Paid plans from $2.10 / 1,000 events (Scraped place). ' +
                'Use fetch-actor-details for the full pricing table.',
        );
    });

    it('user on DIAMOND — resolved tier is DIAMOND, pricingNote is suppressed (top tier)', () => {
        const info = {
            pricingModel: ACTOR_PRICING_MODEL.PRICE_PER_DATASET_ITEM,
            pricePerUnitUsd: 0.005,
            unitName: 'result',
            tieredPricing: {
                FREE: { tieredPricePerUnitUsd: 0.005 },
                GOLD: { tieredPricePerUnitUsd: 0.002 },
                DIAMOND: { tieredPricePerUnitUsd: 0.001 },
            },
        } as unknown as PricingInfo;
        expect(pricingInfoToSimplifiedString(info, 'DIAMOND')).toBe('This Actor costs $1.00 / 1,000 results.');
    });

    it('E8: FREE actor', () => {
        expect(pricingInfoToSimplifiedString(freeActor, 'GOLD')).toBe(
            'This Actor is free to use. You are only charged for Apify platform usage.',
        );
    });

    it('omits pricingNote text when PAY_PER_EVENT events resolve to different tiers', () => {
        expect(pricingInfoToSimplifiedString(mixedTierPayPerEvent, 'GOLD')).toBe(
            'This Actor is paid per event:\n  - **A**:  ($5.00 / 1,000 events)\n  - **B**:  ($20.00 / 1,000 events)',
        );
    });

    it('omits event descriptions in text when PAY_PER_EVENT has more than 5 events', () => {
        expect(pricingInfoToSimplifiedString(longPayPerEvent, 'FREE')).toBe(
            'This Actor is paid per event:\n' +
                '  - **Result**: $3.70 / 1,000 events\n' +
                '  - **Add-on: Date filter**: $1.30 / 1,000 events\n' +
                '  - **Add-on: Popularity filter**: $1.30 / 1,000 events\n' +
                '  - **Add-on: Follower / Following**: $4.00 / 1,000 events\n' +
                '  - **Add-on: Search video sorting**: $1.30 / 1,000 events\n' +
                `  - **Actor start**: $0.001 per run\n${EVENT_DESCRIPTIONS_OMITTED_NOTE}`,
        );
    });
});
