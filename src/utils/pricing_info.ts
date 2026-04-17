import type {
    ActorRunPricingInfo,
    PricePerEventActorPricingInfo as PricePerEventActorPricingInfoOutdated,
} from 'apify-client';

import { ACTOR_PRICING_MODEL, HelperTools } from '../const.js';

export type TieredEventPrice = {
    tieredEventPriceUsd: number;
};

export const PRICING_TIERS = ['FREE', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND'] as const;
export type PricingTier = typeof PRICING_TIERS[number];

export type ActorChargeEvent = {
    eventTitle: string;
    eventDescription?: string;
    eventPriceUsd?: number;
    eventTieredPricingUsd?: Partial<Record<PricingTier, TieredEventPrice>>;
};

export type TieredPricing = {
    [tier: string]: {
        tieredPricePerUnitUsd: number;
    };
};

type PricePerEventActorPricingInfo = PricePerEventActorPricingInfoOutdated & {
    pricingPerEvent: {
        actorChargeEvents: Record<string, ActorChargeEvent>;
    };
};

export type PricingInfo = ActorRunPricingInfo & {
    tieredPricing?: TieredPricing;
} | PricePerEventActorPricingInfo;

/**
 * Custom type to transform raw API pricing data into a clean, client-friendly format
 * that matches the style of the unstructured text output instead of using the raw API format.
 */
export type StructuredPricingInfo = {
    model: string;
    isFree: boolean;
    pricePerUnit?: number;
    unitName?: string;
    trialMinutes?: number;
    tieredPricing?: {
        tier: string;
        pricePerUnit: number;
    }[];
    events?: {
        title: string;
        description: string;
        priceUsd?: number;
        tieredPricing?: {
            tier: string;
            priceUsd: number;
        }[];
    }[];
    /** Hint added when pricing is simplified to a single tier. */
    pricingNote?: string;
};

export const SIMPLIFIED_PRICING_NOTE = `Higher subscription tiers may offer lower prices. Use ${HelperTools.ACTOR_GET_DETAILS} for complete pricing.`;

/**
 * Filters a tiered map down to a single tier (FREE fallback, then first entry).
 * Returns all entries unchanged when `forTier` is undefined or the map has ≤1 entry.
 * `simplified` is true only when filtering actually reduced the entry count.
 */
function selectTierEntries<T>(
    map: Record<string, T> | undefined,
    forTier: PricingTier | undefined,
): { entries: [string, T][]; simplified: boolean } {
    if (!map) return { entries: [], simplified: false };
    const all = Object.entries(map);
    if (!forTier || all.length <= 1) return { entries: all, simplified: false };
    let key: string;
    if (map[forTier]) key = forTier;
    else if (map.FREE) key = 'FREE';
    else key = all[0][0];
    return { entries: [[key, map[key]]], simplified: true };
}

/**
 * Returns the most recent valid pricing information from a list of pricing infos,
 * based on the provided current date.
 *
 * Filters out pricing infos that have a `startedAt` date in the future or missing,
 * then sorts the remaining infos by `startedAt` in descending order (most recent first).
 * Returns the most recent valid pricing info, or `null` if none are valid.
 */
export function getCurrentPricingInfo(pricingInfos: PricingInfo[], now: Date): PricingInfo | null {
    // Filter out all future dates and those without a startedAt date
    const validPricingInfos = pricingInfos.filter((info) => {
        if (!info.startedAt) return false;
        const startedAt = new Date(info.startedAt);
        return startedAt <= now;
    });

    // Sort and return the most recent pricing info
    validPricingInfos.sort((a, b) => {
        const aDate = new Date(a.startedAt || 0);
        const bDate = new Date(b.startedAt || 0);
        return bDate.getTime() - aDate.getTime(); // Sort descending
    });
    if (validPricingInfos.length > 0) {
        return validPricingInfos[0]; // Return the most recent pricing info
    }

    return null;
}

function convertMinutesToGreatestUnit(minutes: number): { value: number; unit: string } {
    if (minutes < 60) {
        return { value: minutes, unit: 'minutes' };
    } if (minutes < 60 * 24) { // Less than 24 hours
        return { value: Math.floor(minutes / 60), unit: 'hours' };
    } // 24 hours or more
    return { value: Math.floor(minutes / (60 * 24)), unit: 'days' };
}

/**
 * Formats the pay-per-event pricing information into a human-readable string.
 *
 * Example:
 * This Actor is paid per event. You are not charged for the Apify platform usage, but only a fixed price for the following events:
 *         - Event title: Event description (Flat price: $X per event)
 *         - MCP server startup: Initial fee for starting the Kiwi MCP Server Actor (Flat price: $0.1 per event)
 *         - Flight search: Fee for searching flights using the Kiwi.com flight search engine (Flat price: $0.001 per event)
 *
 * For tiered pricing, the output is more complicated and the question is whether we want to simplify it in the future.
 * @param pricingPerEvent
 */
function payPerEventPricingToString(
    pricingPerEvent: { actorChargeEvents: Record<string, ActorChargeEvent> } | undefined,
    forTier: PricingTier | undefined,
): string {
    if (!pricingPerEvent || !pricingPerEvent.actorChargeEvents) return 'Pricing information for events is not available.';
    const eventStrings: string[] = [];
    let anySimplified = false;
    for (const event of Object.values(pricingPerEvent.actorChargeEvents)) {
        let eventStr = `\t- **${event.eventTitle}**: ${event.eventDescription} `;
        if (typeof event.eventPriceUsd === 'number') {
            eventStr += `(Flat price: $${event.eventPriceUsd} per event)`;
        } else if (event.eventTieredPricingUsd) {
            const { entries, simplified } = selectTierEntries(event.eventTieredPricingUsd, forTier);
            if (simplified) anySimplified = true;
            const tiers = entries
                .map(([tier, price]) => `${tier}: $${price.tieredEventPriceUsd}`)
                .join(', ');
            eventStr += `(Tiered pricing: ${tiers} per event)`;
        } else {
            eventStr += '(No price info)';
        }
        eventStrings.push(eventStr);
    }
    const suffix = anySimplified ? `\n${SIMPLIFIED_PRICING_NOTE}` : '';
    return `This Actor is paid per event. You are not charged for the Apify platform usage, but only a fixed price for the following events:\n${eventStrings.join('\n')}${suffix}`;
}

/**
 * Formats pricing info as a human-readable string.
 *
 * When `forTier` is provided and the Actor has tiered pricing with more than one
 * tier, the output is collapsed to that single tier (with FREE fallback, then first
 * entry) and `SIMPLIFIED_PRICING_NOTE` is appended. Without `forTier`, all tiers
 * are shown — the original behavior used by fetch-actor-details.
 */
export function pricingInfoToString(
    pricingInfo: PricingInfo | null,
    forTier?: PricingTier,
): string {
    // If there is no pricing infos entries the Actor is free to use
    // based on https://github.com/apify/apify-core/blob/058044945f242387dde2422b8f1bef395110a1bf/src/packages/actor/src/paid_actors/paid_actors_common.ts#L691
    if (pricingInfo === null || pricingInfo.pricingModel === ACTOR_PRICING_MODEL.FREE) {
        return 'This Actor is free to use. You are only charged for Apify platform usage.';
    }
    if (pricingInfo.pricingModel === ACTOR_PRICING_MODEL.PRICE_PER_DATASET_ITEM) {
        const customUnitName = pricingInfo.unitName !== 'result' ? pricingInfo.unitName : '';
        const unitLabel = customUnitName || 'results';
        // Handle tiered pricing if present
        const { entries, simplified } = selectTierEntries(pricingInfo.tieredPricing, forTier);
        if (entries.length > 0) {
            const tiers = entries
                .map(([tier, obj]) => `${tier}: $${obj.tieredPricePerUnitUsd * 1000} per 1000 ${unitLabel}`)
                .join(', ');
            const note = simplified ? ` ${SIMPLIFIED_PRICING_NOTE}` : '';
            return `This Actor charges per results${customUnitName ? ` (in this case named ${customUnitName})` : ''}; tiered pricing per 1000 ${unitLabel}: ${tiers}.${note}`;
        }
        return `This Actor charges per results${customUnitName ? ` (in this case named ${customUnitName})` : ''}; the price per 1000 ${unitLabel} is ${(pricingInfo.pricePerUnitUsd as number) * 1000} USD.`;
    }
    if (pricingInfo.pricingModel === ACTOR_PRICING_MODEL.FLAT_PRICE_PER_MONTH) {
        const { value, unit } = convertMinutesToGreatestUnit(pricingInfo.trialMinutes || 0);
        // Handle tiered pricing if present
        const { entries, simplified } = selectTierEntries(pricingInfo.tieredPricing, forTier);
        if (entries.length > 0) {
            const tiers = entries
                .map(([tier, obj]) => `${tier}: $${obj.tieredPricePerUnitUsd} per month`)
                .join(', ');
            const note = simplified ? ` ${SIMPLIFIED_PRICING_NOTE}` : '';
            return `This Actor is rental and has tiered pricing per month: ${tiers}, with a trial period of ${value} ${unit}.${note}`;
        }
        return `This Actor is rental and has a flat price of ${pricingInfo.pricePerUnitUsd} USD per month, with a trial period of ${value} ${unit}.`;
    }
    if (pricingInfo.pricingModel === ACTOR_PRICING_MODEL.PAY_PER_EVENT) {
        return payPerEventPricingToString(pricingInfo.pricingPerEvent, forTier);
    }
    return 'Pricing information is not available.';
}

/**
 * Transform and normalize API response to match unstructured text output format
 * instead of just dumping raw API data - ensures consistency across structured & unstructured modes.
 *
 * When `forTier` is provided, `tieredPricing` arrays (top-level and per-event) are
 * collapsed to that tier's entry (FREE fallback, then first) and `pricingNote`
 * is set — but only when filtering actually reduced an array. Without `forTier`,
 * all tiers are preserved.
 */
export function pricingInfoToStructured(
    pricingInfo: PricingInfo | null,
    forTier?: PricingTier,
): StructuredPricingInfo {
    const result: StructuredPricingInfo = {
        model: pricingInfo?.pricingModel || ACTOR_PRICING_MODEL.FREE,
        isFree: !pricingInfo || pricingInfo.pricingModel === ACTOR_PRICING_MODEL.FREE,
    };

    if (!pricingInfo || pricingInfo.pricingModel === ACTOR_PRICING_MODEL.FREE) {
        return result;
    }

    if (pricingInfo.pricingModel === ACTOR_PRICING_MODEL.PRICE_PER_DATASET_ITEM) {
        result.pricePerUnit = pricingInfo.pricePerUnitUsd || 0;
        result.unitName = pricingInfo.unitName || 'result';
        if (pricingInfo.tieredPricing && Object.keys(pricingInfo.tieredPricing).length > 0) {
            result.tieredPricing = Object.entries(pricingInfo.tieredPricing).map(([tier, obj]) => ({
                tier,
                pricePerUnit: obj.tieredPricePerUnitUsd,
            }));
        }
    } else if (pricingInfo.pricingModel === ACTOR_PRICING_MODEL.FLAT_PRICE_PER_MONTH) {
        result.pricePerUnit = pricingInfo.pricePerUnitUsd;
        result.trialMinutes = pricingInfo.trialMinutes;
        if (pricingInfo.tieredPricing && Object.keys(pricingInfo.tieredPricing).length > 0) {
            result.tieredPricing = Object.entries(pricingInfo.tieredPricing).map(([tier, obj]) => ({
                tier,
                pricePerUnit: obj.tieredPricePerUnitUsd,
            }));
        }
    } else if (pricingInfo.pricingModel === ACTOR_PRICING_MODEL.PAY_PER_EVENT) {
        if (pricingInfo.pricingPerEvent?.actorChargeEvents) {
            const { actorChargeEvents } = pricingInfo.pricingPerEvent;
            result.events = Object.entries(actorChargeEvents).map(([, event]) => {
                const actorEvent = event as ActorChargeEvent;
                return {
                    title: actorEvent.eventTitle,
                    description: actorEvent.eventDescription || '',
                    priceUsd: typeof actorEvent.eventPriceUsd === 'number' ? actorEvent.eventPriceUsd : undefined,
                    tieredPricing: actorEvent.eventTieredPricingUsd
                        ? Object.entries(actorEvent.eventTieredPricingUsd)
                            .map(([tier, price]) => ({ tier, priceUsd: price.tieredEventPriceUsd }))
                        : undefined,
                };
            });
        }
    }

    if (!forTier) return result;

    let simplified = false;
    if (result.tieredPricing && result.tieredPricing.length > 1) {
        const picked = result.tieredPricing.find((t) => t.tier === forTier)
            ?? result.tieredPricing.find((t) => t.tier === 'FREE')
            ?? result.tieredPricing[0];
        result.tieredPricing = [picked];
        simplified = true;
    }
    if (result.events) {
        for (const event of result.events) {
            if (event.tieredPricing && event.tieredPricing.length > 1) {
                const picked = event.tieredPricing.find((t) => t.tier === forTier)
                    ?? event.tieredPricing.find((t) => t.tier === 'FREE')
                    ?? event.tieredPricing[0];
                event.tieredPricing = [picked];
                simplified = true;
            }
        }
    }
    if (simplified) result.pricingNote = SIMPLIFIED_PRICING_NOTE;
    return result;
}
