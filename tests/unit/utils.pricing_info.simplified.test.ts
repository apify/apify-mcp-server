import { describe, expect, it } from 'vitest';

import { ACTOR_PRICING_MODEL } from '../../src/const.js';
import {
    type PricingInfo,
    pricingInfoToSimplifiedString,
    pricingInfoToSimplifiedStructured,
} from '../../src/utils/pricing_info.js';

const HINT = 'Higher subscription tiers may offer lower prices. Use fetch-actor-details for complete pricing.';

describe('pricingInfoToSimplifiedString', () => {
    it('returns free message for FREE pricing', () => {
        const out = pricingInfoToSimplifiedString({ pricingModel: ACTOR_PRICING_MODEL.FREE } as PricingInfo, 'GOLD');
        expect(out).toContain('free to use');
        expect(out).not.toContain(HINT);
    });

    it('returns free message when pricingInfo is null', () => {
        expect(pricingInfoToSimplifiedString(null, 'GOLD')).toContain('free to use');
    });

    it('PRICE_PER_DATASET_ITEM with tiered pricing shows only user tier + hint', () => {
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
        const out = pricingInfoToSimplifiedString(info, 'GOLD');
        expect(out).toContain('GOLD tier');
        expect(out).toContain('$2');
        expect(out).not.toContain('BRONZE');
        expect(out).not.toContain('FREE:');
        expect(out).toContain(HINT);
    });

    it('defaults to FREE tier when userTier is undefined', () => {
        const info = {
            pricingModel: ACTOR_PRICING_MODEL.PRICE_PER_DATASET_ITEM,
            pricePerUnitUsd: 0.005,
            unitName: 'result',
            tieredPricing: {
                FREE: { tieredPricePerUnitUsd: 0.005 },
                GOLD: { tieredPricePerUnitUsd: 0.002 },
            },
        } as unknown as PricingInfo;
        const out = pricingInfoToSimplifiedString(info);
        expect(out).toContain('FREE tier');
        expect(out).not.toContain('GOLD');
        expect(out).toContain(HINT);
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
        const out = pricingInfoToSimplifiedString(info, 'DIAMOND');
        expect(out).toContain('FREE tier');
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
        const out = pricingInfoToSimplifiedString(info, 'DIAMOND');
        expect(out).toContain('BRONZE tier');
    });

    it('PAY_PER_EVENT shows only user tier per event + single hint', () => {
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
        const out = pricingInfoToSimplifiedString(info, 'GOLD');
        expect(out).toContain('GOLD tier: $0.002');
        expect(out).toContain('Flat price: $0.00005');
        expect(out).not.toContain('FREE:');
        expect(out).not.toContain('DIAMOND');
        // Single hint at the end, not per-event
        expect(out.match(new RegExp(HINT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))?.length).toBe(1);
    });

    it('FLAT_PRICE_PER_MONTH with tiered pricing shows user tier + hint', () => {
        const info = {
            pricingModel: ACTOR_PRICING_MODEL.FLAT_PRICE_PER_MONTH,
            pricePerUnitUsd: 30,
            trialMinutes: 60 * 24 * 7,
            tieredPricing: {
                FREE: { tieredPricePerUnitUsd: 30 },
                GOLD: { tieredPricePerUnitUsd: 20 },
            },
        } as unknown as PricingInfo;
        const out = pricingInfoToSimplifiedString(info, 'GOLD');
        expect(out).toContain('GOLD tier: $20 per month');
        expect(out).toContain(HINT);
    });
});

describe('pricingInfoToSimplifiedStructured', () => {
    it('FREE pricing returns isFree without note', () => {
        const out = pricingInfoToSimplifiedStructured({ pricingModel: ACTOR_PRICING_MODEL.FREE } as PricingInfo, 'GOLD');
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
        const out = pricingInfoToSimplifiedStructured(info, 'GOLD');
        expect(out.tieredPricing).toEqual([{ tier: 'GOLD', pricePerUnit: 0.002 }]);
        expect(out.pricingNote).toBe(HINT);
    });

    it('defaults to FREE tier when userTier is undefined', () => {
        const info = {
            pricingModel: ACTOR_PRICING_MODEL.PRICE_PER_DATASET_ITEM,
            pricePerUnitUsd: 0.005,
            unitName: 'result',
            tieredPricing: {
                FREE: { tieredPricePerUnitUsd: 0.005 },
                GOLD: { tieredPricePerUnitUsd: 0.002 },
            },
        } as unknown as PricingInfo;
        const out = pricingInfoToSimplifiedStructured(info);
        expect(out.tieredPricing).toEqual([{ tier: 'FREE', pricePerUnit: 0.005 }]);
        expect(out.pricingNote).toBe(HINT);
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
        const out = pricingInfoToSimplifiedStructured(info, 'GOLD');
        expect(out.events).toHaveLength(2);
        expect(out.events![0].tieredPricing).toEqual([{ tier: 'GOLD', priceUsd: 0.002 }]);
        // Flat-priced event preserved as-is
        expect(out.events![1].priceUsd).toBe(0.00005);
        expect(out.events![1].tieredPricing).toBeUndefined();
        expect(out.pricingNote).toBe(HINT);
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
        const out = pricingInfoToSimplifiedStructured(info, 'GOLD');
        expect(out.pricingNote).toBeUndefined();
    });
});
