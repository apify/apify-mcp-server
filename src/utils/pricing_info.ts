import type {
    ActorRunPricingInfo,
    PricePerEventActorPricingInfo as PricePerEventActorPricingInfoOutdated,
} from 'apify-client';

import { ACTOR_PRICING_MODEL } from '../const.js';

export type TieredEventPrice = {
    tieredEventPriceUsd: number;
};

export type PricingTier = 'FREE' | 'BRONZE' | 'SILVER' | 'GOLD' | 'PLATINUM' | 'DIAMOND';

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

const SIMPLIFIED_PRICING_NOTE = 'Higher subscription tiers may offer lower prices. Use fetch-actor-details for complete pricing.';

/**
 * Picks the user's tier from a tiered pricing map, falling back to FREE, then the first available tier.
 * Returns null if the map is empty.
 */
function pickTierEntry<T>(
    tieredMap: Record<string, T> | undefined,
    userTier: PricingTier,
): { tier: string; value: T } | null {
    if (!tieredMap) return null;
    const entries = Object.entries(tieredMap);
    if (entries.length === 0) return null;
    const userMatch = entries.find(([t]) => t === userTier);
    if (userMatch) return { tier: userMatch[0], value: userMatch[1] };
    const freeMatch = entries.find(([t]) => t === 'FREE');
    if (freeMatch) return { tier: freeMatch[0], value: freeMatch[1] };
    return { tier: entries[0][0], value: entries[0][1] };
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

function payPerEventPricingToString(pricingPerEvent: { actorChargeEvents: Record<string, ActorChargeEvent> } | undefined): string {
    if (!pricingPerEvent || !pricingPerEvent.actorChargeEvents) return 'Pricing information for events is not available.';
    const eventStrings: string[] = [];
    for (const event of Object.values(pricingPerEvent.actorChargeEvents)) {
        let eventStr = `\t- **${event.eventTitle}**: ${event.eventDescription} `;
        if (typeof event.eventPriceUsd === 'number') {
            eventStr += `(Flat price: $${event.eventPriceUsd} per event)`;
        } else if (event.eventTieredPricingUsd) {
            const tiers = Object.entries(event.eventTieredPricingUsd)
                .map(([tier, price]) => `${tier}: $${price.tieredEventPriceUsd}`)
                .join(', ');
            eventStr += `(Tiered pricing: ${tiers} per event)`;
        } else {
            eventStr += '(No price info)';
        }
        eventStrings.push(eventStr);
    }
    return `This Actor is paid per event. You are not charged for the Apify platform usage, but only a fixed price for the following events:\n${eventStrings.join('\n')}`;
}

export function pricingInfoToString(pricingInfo: PricingInfo | null): string {
    // If there is no pricing infos entries the Actor is free to use
    // based on https://github.com/apify/apify-core/blob/058044945f242387dde2422b8f1bef395110a1bf/src/packages/actor/src/paid_actors/paid_actors_common.ts#L691
    if (pricingInfo === null || pricingInfo.pricingModel === ACTOR_PRICING_MODEL.FREE) {
        return 'This Actor is free to use. You are only charged for Apify platform usage.';
    }
    if (pricingInfo.pricingModel === ACTOR_PRICING_MODEL.PRICE_PER_DATASET_ITEM) {
        const customUnitName = pricingInfo.unitName !== 'result' ? pricingInfo.unitName : '';
        // Handle tiered pricing if present
        if (pricingInfo.tieredPricing && Object.keys(pricingInfo.tieredPricing).length > 0) {
            const tiers = Object.entries(pricingInfo.tieredPricing)
                .map(([tier, obj]) => `${tier}: $${obj.tieredPricePerUnitUsd * 1000} per 1000 ${customUnitName || 'results'}`)
                .join(', ');
            return `This Actor charges per results${customUnitName ? ` (in this case named ${customUnitName})` : ''}; tiered pricing per 1000 ${customUnitName || 'results'}: ${tiers}.`;
        }
        return `This Actor charges per results${customUnitName ? ` (in this case named ${customUnitName})` : ''}; the price per 1000 ${customUnitName || 'results'} is ${pricingInfo.pricePerUnitUsd as number * 1000} USD.`;
    }
    if (pricingInfo.pricingModel === ACTOR_PRICING_MODEL.FLAT_PRICE_PER_MONTH) {
        const { value, unit } = convertMinutesToGreatestUnit(pricingInfo.trialMinutes || 0);
        // Handle tiered pricing if present
        if (pricingInfo.tieredPricing && Object.keys(pricingInfo.tieredPricing).length > 0) {
            const tiers = Object.entries(pricingInfo.tieredPricing)
                .map(([tier, obj]) => `${tier}: $${obj.tieredPricePerUnitUsd} per month`)
                .join(', ');
            return `This Actor is rental and has tiered pricing per month: ${tiers}, with a trial period of ${value} ${unit}.`;
        }
        return `This Actor is rental and has a flat price of ${pricingInfo.pricePerUnitUsd} USD per month, with a trial period of ${value} ${unit}.`;
    }
    if (pricingInfo.pricingModel === ACTOR_PRICING_MODEL.PAY_PER_EVENT) {
        return payPerEventPricingToString(pricingInfo.pricingPerEvent);
    }
    return 'Pricing information is not available.';
}

/**
 * Transform and normalize API response to match unstructured text output format
 * instead of just dumping raw API data - ensures consistency across structured & unstructured modes.
 */
export function pricingInfoToStructured(pricingInfo: PricingInfo | null): StructuredPricingInfo {
    const structuredPricing: StructuredPricingInfo = {
        model: pricingInfo?.pricingModel || ACTOR_PRICING_MODEL.FREE,
        isFree: !pricingInfo || pricingInfo.pricingModel === ACTOR_PRICING_MODEL.FREE,
    };

    if (!pricingInfo || pricingInfo.pricingModel === ACTOR_PRICING_MODEL.FREE) {
        return structuredPricing;
    }

    if (pricingInfo.pricingModel === ACTOR_PRICING_MODEL.PRICE_PER_DATASET_ITEM) {
        structuredPricing.pricePerUnit = pricingInfo.pricePerUnitUsd || 0;
        structuredPricing.unitName = pricingInfo.unitName || 'result';

        if (pricingInfo.tieredPricing && Object.keys(pricingInfo.tieredPricing).length > 0) {
            structuredPricing.tieredPricing = Object.entries(pricingInfo.tieredPricing).map(([tier, obj]) => ({
                tier,
                pricePerUnit: obj.tieredPricePerUnitUsd,
            }));
        }
    } else if (pricingInfo.pricingModel === ACTOR_PRICING_MODEL.FLAT_PRICE_PER_MONTH) {
        structuredPricing.pricePerUnit = pricingInfo.pricePerUnitUsd;
        structuredPricing.trialMinutes = pricingInfo.trialMinutes;

        if (pricingInfo.tieredPricing && Object.keys(pricingInfo.tieredPricing).length > 0) {
            structuredPricing.tieredPricing = Object.entries(pricingInfo.tieredPricing).map(([tier, obj]) => ({
                tier,
                pricePerUnit: obj.tieredPricePerUnitUsd,
            }));
        }
    } else if (pricingInfo.pricingModel === ACTOR_PRICING_MODEL.PAY_PER_EVENT) {
        if (pricingInfo.pricingPerEvent?.actorChargeEvents) {
            const { actorChargeEvents } = pricingInfo.pricingPerEvent;
            structuredPricing.events = Object.entries(actorChargeEvents).map(([, event]) => {
                const actorEvent = event as ActorChargeEvent;
                return {
                    title: actorEvent.eventTitle,
                    description: actorEvent.eventDescription || '',
                    priceUsd: typeof actorEvent.eventPriceUsd === 'number' ? actorEvent.eventPriceUsd : undefined,
                    tieredPricing: actorEvent.eventTieredPricingUsd
                        ? Object.entries(actorEvent.eventTieredPricingUsd)
                            .map(([tier, price]) => ({
                                tier,
                                priceUsd: price.tieredEventPriceUsd,
                            }))
                        : undefined,
                };
            });
        }
    }

    return structuredPricing;
}

/**
 * Simplified text pricing for search-actors: shows only the user's tier price
 * (with FREE fallback) and appends a hint about other tiers.
 *
 * Defaults to FREE when `userTier` is undefined.
 */
export function pricingInfoToSimplifiedString(
    pricingInfo: PricingInfo | null,
    userTier: PricingTier = 'FREE',
): string {
    if (pricingInfo === null || pricingInfo.pricingModel === ACTOR_PRICING_MODEL.FREE) {
        return 'This Actor is free to use. You are only charged for Apify platform usage.';
    }
    if (pricingInfo.pricingModel === ACTOR_PRICING_MODEL.PRICE_PER_DATASET_ITEM) {
        const customUnitName = pricingInfo.unitName !== 'result' ? pricingInfo.unitName : '';
        const unitLabel = customUnitName || 'results';
        const picked = pickTierEntry(pricingInfo.tieredPricing, userTier);
        if (picked) {
            return `This Actor charges per results${customUnitName ? ` (in this case named ${customUnitName})` : ''}; price per 1000 ${unitLabel} for ${picked.tier} tier: $${picked.value.tieredPricePerUnitUsd * 1000}. ${SIMPLIFIED_PRICING_NOTE}`;
        }
        return `This Actor charges per results${customUnitName ? ` (in this case named ${customUnitName})` : ''}; the price per 1000 ${unitLabel} is ${(pricingInfo.pricePerUnitUsd as number) * 1000} USD.`;
    }
    if (pricingInfo.pricingModel === ACTOR_PRICING_MODEL.FLAT_PRICE_PER_MONTH) {
        const { value, unit } = convertMinutesToGreatestUnit(pricingInfo.trialMinutes || 0);
        const picked = pickTierEntry(pricingInfo.tieredPricing, userTier);
        if (picked) {
            return `This Actor is rental; price for ${picked.tier} tier: $${picked.value.tieredPricePerUnitUsd} per month, with a trial period of ${value} ${unit}. ${SIMPLIFIED_PRICING_NOTE}`;
        }
        return `This Actor is rental and has a flat price of ${pricingInfo.pricePerUnitUsd} USD per month, with a trial period of ${value} ${unit}.`;
    }
    if (pricingInfo.pricingModel === ACTOR_PRICING_MODEL.PAY_PER_EVENT) {
        const events = pricingInfo.pricingPerEvent?.actorChargeEvents;
        if (!events) return 'Pricing information for events is not available.';
        const lines: string[] = [];
        let hasTieredEvent = false;
        for (const rawEvent of Object.values(events)) {
            const event = rawEvent as ActorChargeEvent;
            let line = `\t- **${event.eventTitle}**: ${event.eventDescription} `;
            if (typeof event.eventPriceUsd === 'number') {
                line += `(Flat price: $${event.eventPriceUsd} per event)`;
            } else if (event.eventTieredPricingUsd) {
                hasTieredEvent = true;
                const picked = pickTierEntry(event.eventTieredPricingUsd, userTier);
                line += picked
                    ? `(${picked.tier} tier: $${picked.value.tieredEventPriceUsd} per event)`
                    : '(No price info)';
            } else {
                line += '(No price info)';
            }
            lines.push(line);
        }
        const suffix = hasTieredEvent ? `\n${SIMPLIFIED_PRICING_NOTE}` : '';
        return `This Actor is paid per event. You are not charged for the Apify platform usage, but only a fixed price for the following events:\n${lines.join('\n')}${suffix}`;
    }
    return 'Pricing information is not available.';
}

/**
 * Simplified structured pricing for search-actors: collapses tiered pricing arrays
 * to a single entry for the user's tier (with FREE fallback) and sets `pricingNote`.
 *
 * Defaults to FREE when `userTier` is undefined.
 */
export function pricingInfoToSimplifiedStructured(
    pricingInfo: PricingInfo | null,
    userTier: PricingTier = 'FREE',
): StructuredPricingInfo {
    const result = pricingInfoToStructured(pricingInfo);
    let simplified = false;

    if (result.tieredPricing && result.tieredPricing.length > 0) {
        const map = Object.fromEntries(result.tieredPricing.map((t) => [t.tier, t]));
        const picked = pickTierEntry(map, userTier);
        if (picked) {
            result.tieredPricing = [picked.value];
            simplified = true;
        }
    }

    if (result.events) {
        result.events = result.events.map((event) => {
            if (!event.tieredPricing || event.tieredPricing.length === 0) return event;
            const map = Object.fromEntries(event.tieredPricing.map((t) => [t.tier, t]));
            const picked = pickTierEntry(map, userTier);
            if (!picked) return event;
            simplified = true;
            return { ...event, tieredPricing: [picked.value] };
        });
    }

    if (simplified) {
        result.pricingNote = SIMPLIFIED_PRICING_NOTE;
    }
    return result;
}
