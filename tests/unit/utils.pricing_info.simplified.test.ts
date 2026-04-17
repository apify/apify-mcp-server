import { describe, expect, it } from 'vitest';

import { ACTOR_PRICING_MODEL } from '../../src/const.js';
import {
    type PricingInfo,
    pricingInfoToString,
    pricingInfoToStructured,
    SIMPLIFIED_PRICING_NOTE,
} from '../../src/utils/pricing_info.js';

describe('pricingInfoToString with userTier', () => {
    it('returns free message for FREE pricing regardless of tier', () => {
        const out = pricingInfoToString({ pricingModel: ACTOR_PRICING_MODEL.FREE } as PricingInfo, 'GOLD');
        expect(out).toContain('free to use');
        expect(out).not.toContain(SIMPLIFIED_PRICING_NOTE);
    });

    it('returns free message when pricingInfo is null', () => {
        expect(pricingInfoToString(null, 'GOLD')).toContain('free to use');
    });

    it('PRICE_PER_DATASET_ITEM with tiered pricing collapses to user tier + note', () => {
        const info = {
            pricingModel: ACTOR_PRICING_MODEL.PRICE_PER_DATASET_ITEM,
            pricePerUnitUsd: 0.005,
            unitName: 'result',
            tieredPricing: {
                FREE: { tieredPricePerUnitUsd: 0.005 },
                BRONZE: { tieredPricePerUnitUsd: 0.004 },
                GOLD: { tieredPricePerUnitUsd: 0.002 },
            },
        } as unknown as PricingInfo;
        const out = pricingInfoToString(info, 'GOLD');
        expect(out).toContain('GOLD: $2');
        expect(out).not.toContain('BRONZE');
        expect(out).not.toContain('FREE:');
        expect(out).toContain(SIMPLIFIED_PRICING_NOTE);
    });

    it('falls back to FREE when user tier is missing from actor pricing', () => {
        const info = {
            pricingModel: ACTOR_PRICING_MODEL.PRICE_PER_DATASET_ITEM,
            pricePerUnitUsd: 0.005,
            unitName: 'result',
            tieredPricing: {
                FREE: { tieredPricePerUnitUsd: 0.005 },
                BRONZE: { tieredPricePerUnitUsd: 0.004 },
            },
        } as unknown as PricingInfo;
        const out = pricingInfoToString(info, 'DIAMOND');
        expect(out).toContain('FREE: $5');
        expect(out).not.toContain('BRONZE');
    });

    it('falls back to first tier when neither user tier nor FREE exist', () => {
        const info = {
            pricingModel: ACTOR_PRICING_MODEL.PRICE_PER_DATASET_ITEM,
            pricePerUnitUsd: 0.005,
            unitName: 'result',
            tieredPricing: {
                BRONZE: { tieredPricePerUnitUsd: 0.004 },
                SILVER: { tieredPricePerUnitUsd: 0.003 },
            },
        } as unknown as PricingInfo;
        const out = pricingInfoToString(info, 'DIAMOND');
        expect(out).toContain('BRONZE: $4');
        expect(out).not.toContain('SILVER');
    });

    it('without userTier shows all tiers and no note', () => {
        const info = {
            pricingModel: ACTOR_PRICING_MODEL.PRICE_PER_DATASET_ITEM,
            pricePerUnitUsd: 0.005,
            unitName: 'result',
            tieredPricing: {
                FREE: { tieredPricePerUnitUsd: 0.005 },
                GOLD: { tieredPricePerUnitUsd: 0.002 },
            },
        } as unknown as PricingInfo;
        const out = pricingInfoToString(info);
        expect(out).toContain('FREE: $5');
        expect(out).toContain('GOLD: $2');
        expect(out).not.toContain(SIMPLIFIED_PRICING_NOTE);
    });

    it('PAY_PER_EVENT collapses each tiered event to user tier + single note', () => {
        const info = {
            pricingModel: ACTOR_PRICING_MODEL.PAY_PER_EVENT,
            pricingPerEvent: {
                actorChargeEvents: {
                    e1: {
                        eventTitle: 'Scraped place',
                        eventDescription: 'Per place',
                        eventTieredPricingUsd: {
                            FREE: { tieredEventPriceUsd: 0.004 },
                            GOLD: { tieredEventPriceUsd: 0.002 },
                            DIAMOND: { tieredEventPriceUsd: 0.001 },
                        },
                    },
                    e2: {
                        eventTitle: 'Actor start',
                        eventDescription: 'Start fee',
                        eventPriceUsd: 0.00005,
                    },
                },
            },
        } as unknown as PricingInfo;
        const out = pricingInfoToString(info, 'GOLD');
        expect(out).toContain('GOLD: $0.002');
        expect(out).toContain('Flat price: $0.00005');
        expect(out).not.toContain('FREE:');
        expect(out).not.toContain('DIAMOND');
        const noteEsc = SIMPLIFIED_PRICING_NOTE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        expect(out.match(new RegExp(noteEsc, 'g'))?.length).toBe(1);
    });

    it('FLAT_PRICE_PER_MONTH with tiered pricing collapses to user tier + note', () => {
        const info = {
            pricingModel: ACTOR_PRICING_MODEL.FLAT_PRICE_PER_MONTH,
            pricePerUnitUsd: 30,
            trialMinutes: 60 * 24 * 7,
            tieredPricing: {
                FREE: { tieredPricePerUnitUsd: 30 },
                GOLD: { tieredPricePerUnitUsd: 20 },
            },
        } as unknown as PricingInfo;
        const out = pricingInfoToString(info, 'GOLD');
        expect(out).toContain('GOLD: $20 per month');
        expect(out).not.toContain('FREE: $30');
        expect(out).toContain(SIMPLIFIED_PRICING_NOTE);
    });
});

describe('pricingInfoToStructured with userTier', () => {
    it('FREE pricing returns isFree without note', () => {
        const out = pricingInfoToStructured({ pricingModel: ACTOR_PRICING_MODEL.FREE } as PricingInfo, 'GOLD');
        expect(out.isFree).toBe(true);
        expect(out.pricingNote).toBeUndefined();
    });

    it('collapses tieredPricing to single user tier entry + sets pricingNote', () => {
        const info = {
            pricingModel: ACTOR_PRICING_MODEL.PRICE_PER_DATASET_ITEM,
            pricePerUnitUsd: 0.005,
            unitName: 'result',
            tieredPricing: {
                FREE: { tieredPricePerUnitUsd: 0.005 },
                GOLD: { tieredPricePerUnitUsd: 0.002 },
            },
        } as unknown as PricingInfo;
        const out = pricingInfoToStructured(info, 'GOLD');
        expect(out.tieredPricing).toEqual([{ tier: 'GOLD', pricePerUnit: 0.002 }]);
        expect(out.pricingNote).toBe(SIMPLIFIED_PRICING_NOTE);
    });

    it('without userTier preserves all tiers and no note', () => {
        const info = {
            pricingModel: ACTOR_PRICING_MODEL.PRICE_PER_DATASET_ITEM,
            pricePerUnitUsd: 0.005,
            unitName: 'result',
            tieredPricing: {
                FREE: { tieredPricePerUnitUsd: 0.005 },
                GOLD: { tieredPricePerUnitUsd: 0.002 },
            },
        } as unknown as PricingInfo;
        const out = pricingInfoToStructured(info);
        expect(out.tieredPricing).toEqual([
            { tier: 'FREE', pricePerUnit: 0.005 },
            { tier: 'GOLD', pricePerUnit: 0.002 },
        ]);
        expect(out.pricingNote).toBeUndefined();
    });

    it('PAY_PER_EVENT collapses each event tieredPricing to user tier', () => {
        const info = {
            pricingModel: ACTOR_PRICING_MODEL.PAY_PER_EVENT,
            pricingPerEvent: {
                actorChargeEvents: {
                    e1: {
                        eventTitle: 'Scraped place',
                        eventDescription: 'Per place',
                        eventTieredPricingUsd: {
                            FREE: { tieredEventPriceUsd: 0.004 },
                            GOLD: { tieredEventPriceUsd: 0.002 },
                            DIAMOND: { tieredEventPriceUsd: 0.001 },
                        },
                    },
                    e2: {
                        eventTitle: 'Actor start',
                        eventDescription: 'Start fee',
                        eventPriceUsd: 0.00005,
                    },
                },
            },
        } as unknown as PricingInfo;
        const out = pricingInfoToStructured(info, 'GOLD');
        expect(out.events).toHaveLength(2);
        expect(out.events![0].tieredPricing).toEqual([{ tier: 'GOLD', priceUsd: 0.002 }]);
        // Flat-priced event preserved as-is
        expect(out.events![1].priceUsd).toBe(0.00005);
        expect(out.events![1].tieredPricing).toBeUndefined();
        expect(out.pricingNote).toBe(SIMPLIFIED_PRICING_NOTE);
    });

    it('does not set pricingNote when nothing was simplified', () => {
        const info = {
            pricingModel: ACTOR_PRICING_MODEL.PAY_PER_EVENT,
            pricingPerEvent: {
                actorChargeEvents: {
                    e1: {
                        eventTitle: 'Actor start',
                        eventDescription: 'Start fee',
                        eventPriceUsd: 0.00005,
                    },
                },
            },
        } as unknown as PricingInfo;
        const out = pricingInfoToStructured(info, 'GOLD');
        expect(out.pricingNote).toBeUndefined();
    });
});
