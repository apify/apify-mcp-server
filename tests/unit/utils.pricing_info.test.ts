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
// These reproduce the examples in res/pricing_output_contract.md.

// E1/E2/E3: compass/crawler-google-places — PAY_PER_EVENT, multi-tier "Scraped place" event,
// flat "Actor start" event.
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
                eventTieredPricingUsd: { FREE: { tieredEventPriceUsd: 0.001 } },
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

const NOTE_GOLD = 'Prices shown are for GOLD tier. Higher tiers may offer lower prices — '
    + 'use fetch-actor-details to see the full pricing table.';
const NOTE_FREE = 'Prices shown are for FREE tier. Higher tiers may offer lower prices — '
    + 'use fetch-actor-details to see the full pricing table.';
const EVENT_DESCRIPTIONS_OMITTED_NOTE = 'Event descriptions were omitted because this actor has many pricing events. '
    + 'Use fetch-actor-details for full pricing details.';

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
    it('E1: PAY_PER_EVENT lists all tiers inline for tiered events, flat for non-tiered', () => {
        const out = pricingInfoToString(multiTierPayPerEvent);
        expect(out).toBe(
            'This Actor is paid per event:\n'
            + '  - **Scraped place**: A Google Maps place scraped '
            + '(FREE: $0.004, BRONZE: $0.004, SILVER: $0.003, '
            + 'GOLD: $0.0021, PLATINUM: $0.00126, DIAMOND: $0.00076 per event)\n'
            + '  - **Actor start**: Initial fee for starting the Actor ($0.00005 per event)',
        );
    });

    it('E4: single-tier event renders as flat (no tier label)', () => {
        expect(pricingInfoToString(singleTierPayPerEvent)).toBe(
            'This Actor is paid per event:\n'
            + '  - **Scraped place**: A Google Maps place scraped ($0.004 per event)',
        );
    });

    it('E5: PRICE_PER_DATASET_ITEM lists all tiers per 1000 results', () => {
        expect(pricingInfoToString(multiTierDatasetItem)).toBe(
            'This Actor has tiered pricing per 1000 results: FREE: $5, BRONZE: $4, GOLD: $2.',
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
    it('E2: user on GOLD — tieredPricing filtered to GOLD entry, pricingNote names GOLD', () => {
        expect(pricingInfoToSimplifiedStructured(multiTierPayPerEvent, 'GOLD')).toEqual({
            model: 'PAY_PER_EVENT',
            userTier: 'GOLD',
            events: [
                {
                    title: 'Scraped place',
                    description: 'A Google Maps place scraped',
                    priceUsd: 0.0021,
                    tieredPricing: [{ tier: 'GOLD', priceUsd: 0.0021 }],
                },
                {
                    title: 'Actor start',
                    description: 'Initial fee for starting the Actor',
                    priceUsd: 0.00005,
                },
            ],
            pricingNote: NOTE_GOLD,
        });
    });

    it('E3: user on DIAMOND, actor offers only FREE — falls back to FREE, userTier stays DIAMOND, note names FREE', () => {
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
            userTier: 'DIAMOND',
            pricePerUnit: 0.005,
            unitName: 'result',
            tieredPricing: [{ tier: 'FREE', pricePerUnit: 0.005 }],
            pricingNote: NOTE_FREE,
        });
    });

    it('falls back to first entry when neither user tier nor FREE exist', () => {
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
        expect(out.tieredPricing).toEqual([{ tier: 'BRONZE', pricePerUnit: 0.004 }]);
        expect(out.pricePerUnit).toBe(0.004);
        expect(out.pricingNote).toContain('BRONZE');
    });

    it('E4: single-tier actor — no pricingNote (the "higher tiers" promise is vacuous)', () => {
        expect(pricingInfoToSimplifiedStructured(singleTierPayPerEvent, 'GOLD')).toEqual({
            model: 'PAY_PER_EVENT',
            userTier: 'GOLD',
            events: [
                {
                    title: 'Scraped place',
                    description: 'A Google Maps place scraped',
                    priceUsd: 0.004,
                    tieredPricing: [{ tier: 'FREE', priceUsd: 0.004 }],
                },
            ],
        });
    });

    it('E6: PRICE_PER_DATASET_ITEM simplified — top-level pricePerUnit reflects resolved tier', () => {
        expect(pricingInfoToSimplifiedStructured(multiTierDatasetItem, 'GOLD')).toEqual({
            model: 'PRICE_PER_DATASET_ITEM',
            userTier: 'GOLD',
            pricePerUnit: 0.002,
            unitName: 'result',
            tieredPricing: [{ tier: 'GOLD', pricePerUnit: 0.002 }],
            pricingNote: NOTE_GOLD,
        });
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
        const out = pricingInfoToSimplifiedStructured(info, 'DIAMOND');
        expect(out.tieredPricing).toEqual([{ tier: 'DIAMOND', pricePerUnit: 0.001 }]);
        expect(out.pricePerUnit).toBe(0.001);
        expect(out.pricingNote).toBeUndefined();
    });

    it('E7: FLAT_PRICE_PER_MONTH simplified includes trialMinutes + resolved tier price', () => {
        expect(pricingInfoToSimplifiedStructured(multiTierRental, 'GOLD')).toEqual({
            model: 'FLAT_PRICE_PER_MONTH',
            userTier: 'GOLD',
            pricePerUnit: 20,
            trialMinutes: 60 * 24 * 7,
            tieredPricing: [{ tier: 'GOLD', pricePerUnit: 20 }],
            pricingNote: NOTE_GOLD,
        });
    });

    it('E8: FREE actor — same minimal shape + userTier in simplified mode too', () => {
        expect(pricingInfoToSimplifiedStructured(freeActor, 'GOLD')).toEqual({
            model: 'FREE',
            userTier: 'GOLD',
        });
    });

    it('omits pricingNote when PAY_PER_EVENT events resolve to different tiers', () => {
        expect(pricingInfoToSimplifiedStructured(mixedTierPayPerEvent, 'GOLD')).toEqual({
            model: 'PAY_PER_EVENT',
            userTier: 'GOLD',
            events: [
                {
                    title: 'A',
                    description: '',
                    priceUsd: 0.005,
                    tieredPricing: [{ tier: 'GOLD', priceUsd: 0.005 }],
                },
                {
                    title: 'B',
                    description: '',
                    priceUsd: 0.02,
                    tieredPricing: [{ tier: 'FREE', priceUsd: 0.02 }],
                },
            ],
        });
    });

    it('omits event descriptions and adds omission metadata when PAY_PER_EVENT has more than 5 events (single-tier: no pricingNote)', () => {
        expect(pricingInfoToSimplifiedStructured(longPayPerEvent, 'FREE')).toEqual({
            model: 'PAY_PER_EVENT',
            userTier: 'FREE',
            events: [
                { title: 'Result', priceUsd: 0.0037, tieredPricing: [{ tier: 'FREE', priceUsd: 0.0037 }] },
                { title: 'Add-on: Date filter', priceUsd: 0.0013, tieredPricing: [{ tier: 'FREE', priceUsd: 0.0013 }] },
                { title: 'Add-on: Popularity filter', priceUsd: 0.0013, tieredPricing: [{ tier: 'FREE', priceUsd: 0.0013 }] },
                { title: 'Add-on: Follower / Following', priceUsd: 0.004, tieredPricing: [{ tier: 'FREE', priceUsd: 0.004 }] },
                { title: 'Add-on: Search video sorting', priceUsd: 0.0013, tieredPricing: [{ tier: 'FREE', priceUsd: 0.0013 }] },
                { title: 'Actor start', priceUsd: 0.001, tieredPricing: [{ tier: 'FREE', priceUsd: 0.001 }] },
            ],
            eventDescriptionsOmitted: true,
            eventDescriptionsNote: EVENT_DESCRIPTIONS_OMITTED_NOTE,
        });
    });
});

describe('pricingInfoToSimplifiedString (simplified mode)', () => {
    it('E2: user on GOLD — one price per event, pricingNote appended', () => {
        expect(pricingInfoToSimplifiedString(multiTierPayPerEvent, 'GOLD')).toBe(
            `This Actor is paid per event:\n`
            + `  - **Scraped place**: A Google Maps place scraped ($0.0021 per event)\n`
            + `  - **Actor start**: Initial fee for starting the Actor ($0.00005 per event)\n${
                NOTE_GOLD}`,
        );
    });

    it('E4: single-tier actor — flat price, no pricingNote', () => {
        expect(pricingInfoToSimplifiedString(singleTierPayPerEvent, 'GOLD')).toBe(
            'This Actor is paid per event:\n'
            + '  - **Scraped place**: A Google Maps place scraped ($0.004 per event)',
        );
    });

    it('E6: PRICE_PER_DATASET_ITEM simplified — single price + note', () => {
        expect(pricingInfoToSimplifiedString(multiTierDatasetItem, 'GOLD')).toBe(
            `This Actor costs $2 per 1000 results. ${NOTE_GOLD}`,
        );
    });

    it('E7: FLAT_PRICE_PER_MONTH simplified — rental price + trial + note', () => {
        expect(pricingInfoToSimplifiedString(multiTierRental, 'GOLD')).toBe(
            `This Actor is rental and costs $20 per month, with a trial period of 7 days. ${NOTE_GOLD}`,
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
        expect(pricingInfoToSimplifiedString(info, 'DIAMOND')).toBe(
            'This Actor costs $1 per 1000 results.',
        );
    });

    it('E8: FREE actor', () => {
        expect(pricingInfoToSimplifiedString(freeActor, 'GOLD')).toBe(
            'This Actor is free to use. You are only charged for Apify platform usage.',
        );
    });
    it('omits pricingNote text when PAY_PER_EVENT events resolve to different tiers', () => {
        expect(pricingInfoToSimplifiedString(mixedTierPayPerEvent, 'GOLD')).toBe(
            'This Actor is paid per event:\n'
            + '  - **A**:  ($0.005 per event)\n'
            + '  - **B**:  ($0.02 per event)',
        );
    });

    it('omits event descriptions in text when PAY_PER_EVENT has more than 5 events', () => {
        expect(pricingInfoToSimplifiedString(longPayPerEvent, 'FREE')).toBe(
            'This Actor is paid per event:\n'
            + '  - **Result**: $0.0037 per event\n'
            + '  - **Add-on: Date filter**: $0.0013 per event\n'
            + '  - **Add-on: Popularity filter**: $0.0013 per event\n'
            + '  - **Add-on: Follower / Following**: $0.004 per event\n'
            + '  - **Add-on: Search video sorting**: $0.0013 per event\n'
            + `  - **Actor start**: $0.001 per event\n${EVENT_DESCRIPTIONS_OMITTED_NOTE}`,
        );
    });
});
