import type { ActorRunPricingInfo } from 'apify-client';

import { ACTOR_PRICING_MODEL } from '../const.js';
import type { ExtendedPricingInfo } from '../types.js';

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

function payPerEventPricingToString(pricingPerEvent: ExtendedPricingInfo['pricingPerEvent']): string {
    if (!pricingPerEvent || !pricingPerEvent.actorChargeEvents) return 'No event pricing information available.';
    const eventStrings: string[] = [];
    for (const event of Object.values(pricingPerEvent.actorChargeEvents)) {
        let eventStr = `- ${event.eventTitle}: ${event.eventDescription} `;
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
    return `This Actor charges per event as follows:\n${eventStrings.join('\n')}`;
}

export function pricingInfoToString(pricingInfo: ExtendedPricingInfo | null): string {
    // If there is no pricing infos entries the Actor is free to use
    // based on https://github.com/apify/apify-core/blob/058044945f242387dde2422b8f1bef395110a1bf/src/packages/actor/src/paid_actors/paid_actors_common.ts#L691
    if (pricingInfo === null || pricingInfo.pricingModel === ACTOR_PRICING_MODEL.FREE) {
        return 'This Actor is free to use; the user only pays for the computing resources consumed by the Actor.';
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
            return `This Actor is rental and thus has tiered pricing per month: ${tiers}, with a trial period of ${value} ${unit}.`;
        }
        return `This Actor is rental and thus has a flat price of ${pricingInfo.pricePerUnitUsd} USD per month, with a trial period of ${value} ${unit}.`;
    }
    if (pricingInfo.pricingModel === ACTOR_PRICING_MODEL.PAY_PER_EVENT) {
        return payPerEventPricingToString(pricingInfo.pricingPerEvent);
    }
    return 'unknown';
}
