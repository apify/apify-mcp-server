import type { ActorRunPricingInfo } from 'apify-client';

import { ACTOR_PRICING_MODEL } from '../const.js';
import type { ExtendedPricingInfo } from '../types.js';

/**
 * Custom type to transform raw API pricing data into a clean, client-friendly format
 * that matches the style of the unstructured text output insteda of using the raw API format.
 */
export interface StructuredPricingInfo {
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
}

/**
 * Returns the most recent valid pricing information from a list of pricing infos,
 * based on the provided current date.
 *
 * Filters out pricing infos that have a `startedAt` date in the future or missing,
 * then sorts the remaining infos by `startedAt` in descending order (most recent first).
 * Returns the most recent valid pricing info, or `null` if none are valid.
 */
export function getCurrentPricingInfo(pricingInfos: ActorRunPricingInfo[], now: Date): ActorRunPricingInfo | null {
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

function payPerEventPricingToString(pricingPerEvent: ExtendedPricingInfo['pricingPerEvent']): string {
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

export function pricingInfoToString(pricingInfo: ExtendedPricingInfo | null): string {
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

export function pricingInfoToStructured(pricingInfo: ExtendedPricingInfo | null): StructuredPricingInfo {
    const structuredPricing: StructuredPricingInfo = {
        model: pricingInfo?.pricingModel || ACTOR_PRICING_MODEL.FREE,
        isFree: !pricingInfo || pricingInfo.pricingModel === ACTOR_PRICING_MODEL.FREE,
    };

    if (!pricingInfo || pricingInfo.pricingModel === ACTOR_PRICING_MODEL.FREE) {
        return structuredPricing;
    }

    if (pricingInfo.pricingModel === ACTOR_PRICING_MODEL.PRICE_PER_DATASET_ITEM) {
        structuredPricing.pricePerUnit = (pricingInfo.pricePerUnitUsd || 0) * 1000; // Convert to price per 1000 units
        structuredPricing.unitName = pricingInfo.unitName || 'result';

        if (pricingInfo.tieredPricing && Object.keys(pricingInfo.tieredPricing).length > 0) {
            structuredPricing.tieredPricing = Object.entries(pricingInfo.tieredPricing).map(([tier, obj]) => ({
                tier,
                pricePerUnit: obj.tieredPricePerUnitUsd * 1000,
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
            structuredPricing.events = Object.values(pricingInfo.pricingPerEvent.actorChargeEvents).map((event) => ({
                title: event.eventTitle,
                description: event.eventDescription || '',
                priceUsd: typeof event.eventPriceUsd === 'number' ? event.eventPriceUsd : undefined,
                tieredPricing: event.eventTieredPricingUsd
                    ? Object.entries(event.eventTieredPricingUsd).map(([tier, price]) => ({
                        tier,
                        priceUsd: price.tieredEventPriceUsd,
                    }))
                    : undefined,
            }));
        }
    }

    return structuredPricing;
}
