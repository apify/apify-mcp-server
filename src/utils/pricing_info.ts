/**
 * Pricing output contract for Actor cards.
 *
 * Text callers:
 * - `pricingInfoToString`: complete mode for `fetch-actor-details`
 * - `pricingInfoToSimplifiedString`: simplified mode for `search-actors`
 *
 * Structured callers:
 * - `pricingInfoToStructured`: complete mode
 * - `pricingInfoToSimplifiedStructured`: simplified mode
 *
 * Structured output shape is mostly the same in both modes:
 * {
 *   model: string,
 *   userTier?: PricingTier,
 *   pricePerUnit?: number,
 *   unitName?: string,
 *   trialMinutes?: number,
 *   tieredPricing?: [{ tier: string, pricePerUnit: number }],
 *   events?: [{
 *     title: string,
 *     description?: string,
 *     priceUsd?: number,
 *     tieredPricing?: [{ tier: string, priceUsd: number }],
 *   }],
 *   pricingNote?: string,
 *   eventDescriptionsOmitted?: boolean,
 *   eventDescriptionsNote?: string,
 * }
 *
 * Complete mode keeps full tier matrices and never sets `pricingNote`.
 *
 * Simplified mode picks a single tier from each tiered map
 * (requested tier -> FREE -> first entry) and emits `pricingNote` only when
 * the Actor actually has multiple tiers *and* they resolve consistently. The
 * note is omitted for single-tier Actors (the note's "higher tiers may offer
 * lower prices" promise is vacuous) and when PAY_PER_EVENT events resolve
 * to different tiers (no truthful single label).
 *
 * Simplified `PAY_PER_EVENT` also trims long event lists:
 * - `events.length <= 5`: keep event descriptions
 * - `events.length > 5`: omit event descriptions and set
 *   `eventDescriptionsOmitted` / `eventDescriptionsNote`
 *
 * Single-tier buckets stay as 1-element `tieredPricing` arrays in both modes.
 * `FREE` or `null` input returns the free text / structured shape.
 *
 * Full examples and contract details are documented inline in this module.
 */

import type {
    ActorRunPricingInfo,
    PricePerEventActorPricingInfo as PricePerEventActorPricingInfoOutdated,
} from 'apify-client';

import { ACTOR_PRICING_MODEL } from '../const.js';

type TieredEventPrice = {
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

export type PricingInfo = (ActorRunPricingInfo & {
    tieredPricing?: TieredPricing;
}) | PricePerEventActorPricingInfo;

/**
 * Public structured pricing contract returned by actor cards.
 *
 * `tieredPricing` and event-level `tieredPricing` always use arrays.
 * The difference between modes is array length:
 * - complete mode: full tier matrix
 * - simplified mode: 1 resolved tier
 */
export type StructuredPricingInfo = {
    model: string;
    userTier?: PricingTier;
    pricePerUnit?: number;
    unitName?: string;
    trialMinutes?: number;
    tieredPricing?: {
        tier: string;
        pricePerUnit: number;
    }[];
    events?: {
        title: string;
        description?: string;
        priceUsd?: number;
        tieredPricing?: {
            tier: string;
            priceUsd: number;
        }[];
    }[];
    pricingNote?: string;
    eventDescriptionsOmitted?: boolean;
    eventDescriptionsNote?: string;
};

type DatasetItemLike = {
    pricePerUnitUsd?: number;
    unitName?: string;
    tieredPricing?: TieredPricing;
};

type RentalLike = {
    pricePerUnitUsd?: number;
    trialMinutes?: number;
    tieredPricing?: TieredPricing;
};

type SimplifiedResult = {
    patch: Partial<StructuredPricingInfo>;
    noteTier: string | null;
};

const FREE_ACTOR_TEXT = 'This Actor is free to use. You are only charged for Apify platform usage.';
const UNKNOWN_PRICING_TEXT = 'Pricing information is not available.';
const EVENTS_UNAVAILABLE_TEXT = 'Pricing information for events is not available.';
const EVENT_DESCRIPTION_LIMIT = 5;
const EVENT_DESCRIPTIONS_OMITTED_NOTE = 'Event descriptions were omitted because this actor has many pricing events. '
    + 'Use fetch-actor-details for full pricing details.';

function resolveTier<T>(
    map: Record<string, T>,
    userTier: PricingTier,
): { tier: string; value: T } {
    if (map[userTier]) return { tier: userTier, value: map[userTier] };
    if (map.FREE) return { tier: 'FREE', value: map.FREE };
    // Pathological fallback: actor provides neither the user's tier nor FREE.
    // `Object.entries` order is spec-guaranteed to be insertion order for string keys,
    // so we pick whichever tier the API serialised first. Rarely fires — virtually every
    // actor defines FREE.
    const [firstTier, firstValue] = Object.entries(map)[0];
    return { tier: firstTier, value: firstValue };
}

/**
 * Builds the simplified-mode pricing note, or returns null when no note should be shown.
 * DIAMOND is the top tier — "higher tiers may offer lower prices" is vacuous, so we skip
 * the note for DIAMOND users.
 */
function buildPricingNote(resolvedTier: string): string | null {
    if (resolvedTier === 'DIAMOND') return null;
    return `Prices shown are for ${resolvedTier} tier. `
        + `Higher tiers may offer lower prices — use fetch-actor-details to see the full pricing table.`;
}

function getSingleResolvedTier(resolvedTiers: Set<string>): string | null {
    if (resolvedTiers.size !== 1) return null;
    return resolvedTiers.values().next().value ?? null;
}

function isFreeActor(
    info: PricingInfo | null,
): info is null | (PricingInfo & { pricingModel: typeof ACTOR_PRICING_MODEL.FREE }) {
    return !info || info.pricingModel === ACTOR_PRICING_MODEL.FREE;
}

function hasTiers<T>(map: Record<string, T> | undefined): map is Record<string, T> {
    return !!map && Object.keys(map).length > 0;
}

function hasMultipleTiers(map: Record<string, unknown> | undefined): boolean {
    return !!map && Object.keys(map).length > 1;
}

function shouldOmitEventDescriptions(eventCount: number): boolean {
    return eventCount > EVENT_DESCRIPTION_LIMIT;
}

function convertMinutesToGreatestUnit(minutes: number): { value: number; unit: string } {
    if (minutes < 60) return { value: minutes, unit: 'minutes' };
    if (minutes < 60 * 24) return { value: Math.floor(minutes / 60), unit: 'hours' };
    return { value: Math.floor(minutes / (60 * 24)), unit: 'days' };
}

export function getCurrentPricingInfo(pricingInfos: PricingInfo[], now: Date): PricingInfo | null {
    const validPricingInfos = pricingInfos.filter((info) => {
        if (!info.startedAt) return false;
        return new Date(info.startedAt) <= now;
    });

    validPricingInfos.sort((a, b) => {
        const aDate = new Date(a.startedAt || 0);
        const bDate = new Date(b.startedAt || 0);
        return bDate.getTime() - aDate.getTime();
    });

    return validPricingInfos[0] ?? null;
}

/** Complete text contract used by `fetch-actor-details`. */
export function pricingInfoToString(pricingInfo: PricingInfo | null): string {
    if (isFreeActor(pricingInfo)) return FREE_ACTOR_TEXT;

    switch (pricingInfo.pricingModel) {
        case ACTOR_PRICING_MODEL.PRICE_PER_DATASET_ITEM:
            return formatDatasetItemComplete(pricingInfo);
        case ACTOR_PRICING_MODEL.FLAT_PRICE_PER_MONTH:
            return formatRentalComplete(pricingInfo);
        case ACTOR_PRICING_MODEL.PAY_PER_EVENT:
            return formatPayPerEventComplete(pricingInfo.pricingPerEvent);
        default:
            return UNKNOWN_PRICING_TEXT;
    }
}

function formatDatasetItemComplete(info: DatasetItemLike): string {
    const unitLabel = info.unitName ? `${info.unitName}s` : 'results';
    const tierEntries = info.tieredPricing ? Object.entries(info.tieredPricing) : [];

    if (tierEntries.length > 1) {
        const tierList = tierEntries
            .map(([tier, obj]) => `${tier}: $${obj.tieredPricePerUnitUsd * 1000}`)
            .join(', ');
        return `This Actor has tiered pricing per 1000 ${unitLabel}: ${tierList}.`;
    }

    const price = tierEntries.length === 1
        ? tierEntries[0][1].tieredPricePerUnitUsd
        : (info.pricePerUnitUsd ?? 0);
    return `This Actor costs $${price * 1000} per 1000 ${unitLabel}.`;
}

function formatRentalComplete(info: RentalLike): string {
    const { value, unit } = convertMinutesToGreatestUnit(info.trialMinutes || 0);
    const tierEntries = info.tieredPricing ? Object.entries(info.tieredPricing) : [];

    if (tierEntries.length > 1) {
        const tierList = tierEntries
            .map(([tier, obj]) => `${tier}: $${obj.tieredPricePerUnitUsd}`)
            .join(', ');
        return `This Actor is rental and has tiered pricing per month: ${tierList}, `
            + `with a trial period of ${value} ${unit}.`;
    }

    const price = tierEntries.length === 1
        ? tierEntries[0][1].tieredPricePerUnitUsd
        : (info.pricePerUnitUsd ?? 0);
    return `This Actor is rental and costs $${price} per month, with a trial period of ${value} ${unit}.`;
}

function formatPayPerEventComplete(
    pricingPerEvent: { actorChargeEvents: Record<string, ActorChargeEvent> } | undefined,
): string {
    if (!pricingPerEvent?.actorChargeEvents) return EVENTS_UNAVAILABLE_TEXT;

    const eventLines = Object.values(pricingPerEvent.actorChargeEvents).map((event) => {
        const detail = formatCompleteEventDetail(event);
        return `  - **${event.eventTitle}**: ${event.eventDescription ?? ''} (${detail})`;
    });

    return `This Actor is paid per event:\n${eventLines.join('\n')}`;
}

function formatCompleteEventDetail(event: ActorChargeEvent): string {
    if (typeof event.eventPriceUsd === 'number') return `$${event.eventPriceUsd} per event`;
    const tiered = event.eventTieredPricingUsd as Record<string, TieredEventPrice> | undefined;
    if (!hasTiers(tiered)) return 'No price info';
    if (hasMultipleTiers(tiered)) {
        return `${Object.entries(tiered)
            .map(([tier, price]) => `${tier}: $${price.tieredEventPriceUsd}`)
            .join(', ')} per event`;
    }
    const [price] = Object.values(tiered);
    return `$${price.tieredEventPriceUsd} per event`;
}

/** Complete structured contract used by `fetch-actor-details`. */
export function pricingInfoToStructured(
    pricingInfo: PricingInfo | null,
    userTier: PricingTier,
): StructuredPricingInfo {
    const base = createStructuredBase(pricingInfo, userTier);
    if (isFreeActor(pricingInfo)) return base;

    switch (pricingInfo.pricingModel) {
        case ACTOR_PRICING_MODEL.PRICE_PER_DATASET_ITEM:
            return { ...base, unitName: pricingInfo.unitName || 'result', ...structureTieredUnitComplete(pricingInfo) };
        case ACTOR_PRICING_MODEL.FLAT_PRICE_PER_MONTH:
            return { ...base, trialMinutes: pricingInfo.trialMinutes, ...structureTieredUnitComplete(pricingInfo) };
        case ACTOR_PRICING_MODEL.PAY_PER_EVENT:
            return { ...base, ...structurePayPerEventComplete(pricingInfo.pricingPerEvent) };
        default:
            return base;
    }
}

function createStructuredBase(
    pricingInfo: PricingInfo | null,
    userTier: PricingTier,
): StructuredPricingInfo {
    return {
        model: pricingInfo?.pricingModel || ACTOR_PRICING_MODEL.FREE,
        userTier,
    };
}

function structureTieredUnitComplete(info: DatasetItemLike | RentalLike): Partial<StructuredPricingInfo> {
    const patch: Partial<StructuredPricingInfo> = { pricePerUnit: info.pricePerUnitUsd ?? 0 };

    if (hasTiers(info.tieredPricing)) {
        patch.tieredPricing = Object.entries(info.tieredPricing).map(([tier, obj]) => ({
            tier,
            pricePerUnit: obj.tieredPricePerUnitUsd,
        }));
    }

    return patch;
}

function structurePayPerEventComplete(
    pricingPerEvent: { actorChargeEvents: Record<string, ActorChargeEvent> } | undefined,
): Partial<StructuredPricingInfo> {
    if (!pricingPerEvent?.actorChargeEvents) return {};

    return {
        events: Object.values(pricingPerEvent.actorChargeEvents).map((event) => ({
            title: event.eventTitle,
            description: event.eventDescription || '',
            priceUsd: typeof event.eventPriceUsd === 'number' ? event.eventPriceUsd : undefined,
            tieredPricing: event.eventTieredPricingUsd
                ? Object.entries(event.eventTieredPricingUsd)
                    .map(([tier, price]) => ({ tier, priceUsd: (price as TieredEventPrice).tieredEventPriceUsd }))
                : undefined,
        })),
    };
}

/** Simplified text contract used by `search-actors`. */
export function pricingInfoToSimplifiedString(
    pricingInfo: PricingInfo | null,
    userTier: PricingTier,
): string {
    if (isFreeActor(pricingInfo)) return FREE_ACTOR_TEXT;

    switch (pricingInfo.pricingModel) {
        case ACTOR_PRICING_MODEL.PRICE_PER_DATASET_ITEM:
            return formatDatasetItemSimplified(pricingInfo, userTier);
        case ACTOR_PRICING_MODEL.FLAT_PRICE_PER_MONTH:
            return formatRentalSimplified(pricingInfo, userTier);
        case ACTOR_PRICING_MODEL.PAY_PER_EVENT:
            return formatPayPerEventSimplified(pricingInfo.pricingPerEvent, userTier);
        default:
            return UNKNOWN_PRICING_TEXT;
    }
}

function formatDatasetItemSimplified(info: DatasetItemLike, userTier: PricingTier): string {
    const unitLabel = info.unitName ? `${info.unitName}s` : 'results';
    if (hasTiers(info.tieredPricing)) {
        const { tier, value } = resolveTier(info.tieredPricing, userTier);
        const base = `This Actor costs $${value.tieredPricePerUnitUsd * 1000} per 1000 ${unitLabel}.`;
        const note = hasMultipleTiers(info.tieredPricing) ? buildPricingNote(tier) : null;
        return note ? `${base} ${note}` : base;
    }
    return `This Actor costs $${(info.pricePerUnitUsd ?? 0) * 1000} per 1000 ${unitLabel}.`;
}

function formatRentalSimplified(info: RentalLike, userTier: PricingTier): string {
    const { value, unit } = convertMinutesToGreatestUnit(info.trialMinutes || 0);
    if (hasTiers(info.tieredPricing)) {
        const { tier, value: entry } = resolveTier(info.tieredPricing, userTier);
        const base = `This Actor is rental and costs $${entry.tieredPricePerUnitUsd} per month, `
            + `with a trial period of ${value} ${unit}.`;
        const note = hasMultipleTiers(info.tieredPricing) ? buildPricingNote(tier) : null;
        return note ? `${base} ${note}` : base;
    }
    return `This Actor is rental and costs $${info.pricePerUnitUsd ?? 0} per month, with a trial period of ${value} ${unit}.`;
}

function formatPayPerEventSimplified(
    pricingPerEvent: { actorChargeEvents: Record<string, ActorChargeEvent> } | undefined,
    userTier: PricingTier,
): string {
    if (!pricingPerEvent?.actorChargeEvents) return EVENTS_UNAVAILABLE_TEXT;

    const events = Object.values(pricingPerEvent.actorChargeEvents);
    const omitDescriptions = shouldOmitEventDescriptions(events.length);
    const resolvedTiers = new Set<string>();
    const eventLines = events.map((event) => {
        let price: number | undefined;

        if (typeof event.eventPriceUsd === 'number') {
            price = event.eventPriceUsd;
        } else if (event.eventTieredPricingUsd) {
            const tieredMap = event.eventTieredPricingUsd as Record<string, TieredEventPrice>;
            if (hasTiers(tieredMap)) {
                const { tier, value } = resolveTier(tieredMap, userTier);
                resolvedTiers.add(tier);
                price = value.tieredEventPriceUsd;
            }
        }

        const detail = typeof price === 'number' ? `$${price} per event` : 'No price info';
        if (omitDescriptions) return `  - **${event.eventTitle}**: ${detail}`;
        return `  - **${event.eventTitle}**: ${event.eventDescription ?? ''} (${detail})`;
    });

    const body = `This Actor is paid per event:\n${eventLines.join('\n')}`;
    const anyMultiTier = events.some((event) => hasMultipleTiers(event.eventTieredPricingUsd));
    const noteTier = anyMultiTier ? getSingleResolvedTier(resolvedTiers) : null;
    const pricingNote = noteTier ? buildPricingNote(noteTier) : null;
    const tail = [pricingNote, omitDescriptions ? EVENT_DESCRIPTIONS_OMITTED_NOTE : null]
        .filter((n): n is string => !!n)
        .join('\n');
    return tail ? `${body}\n${tail}` : body;
}

/** Simplified structured contract used by `search-actors`. */
export function pricingInfoToSimplifiedStructured(
    pricingInfo: PricingInfo | null,
    userTier: PricingTier,
): StructuredPricingInfo {
    const base = createStructuredBase(pricingInfo, userTier);
    if (isFreeActor(pricingInfo)) return base;

    const { patch, noteTier } = resolveSimplifiedPatch(pricingInfo, userTier);
    const pricingNote = noteTier ? buildPricingNote(noteTier) : null;
    return {
        ...base,
        ...patch,
        ...(pricingNote ? { pricingNote } : {}),
    };
}

function resolveSimplifiedPatch(pricingInfo: PricingInfo, userTier: PricingTier): SimplifiedResult {
    switch (pricingInfo.pricingModel) {
        case ACTOR_PRICING_MODEL.PRICE_PER_DATASET_ITEM: {
            const r = structureTieredUnitSimplified(pricingInfo, userTier);
            return { patch: { unitName: pricingInfo.unitName || 'result', ...r.patch }, noteTier: r.noteTier };
        }
        case ACTOR_PRICING_MODEL.FLAT_PRICE_PER_MONTH: {
            const r = structureTieredUnitSimplified(pricingInfo, userTier);
            return { patch: { trialMinutes: pricingInfo.trialMinutes, ...r.patch }, noteTier: r.noteTier };
        }
        case ACTOR_PRICING_MODEL.PAY_PER_EVENT:
            return structurePayPerEventSimplified(pricingInfo.pricingPerEvent, userTier);
        default:
            return { patch: {}, noteTier: null };
    }
}

function structureTieredUnitSimplified(
    info: DatasetItemLike | RentalLike,
    userTier: PricingTier,
): SimplifiedResult {
    const patch: Partial<StructuredPricingInfo> = { pricePerUnit: info.pricePerUnitUsd ?? 0 };
    if (hasTiers(info.tieredPricing)) {
        const { tier, value } = resolveTier(info.tieredPricing, userTier);
        patch.tieredPricing = [{ tier, pricePerUnit: value.tieredPricePerUnitUsd }];
        patch.pricePerUnit = value.tieredPricePerUnitUsd;
        return { patch, noteTier: hasMultipleTiers(info.tieredPricing) ? tier : null };
    }
    return { patch, noteTier: null };
}

function structurePayPerEventSimplified(
    pricingPerEvent: { actorChargeEvents: Record<string, ActorChargeEvent> } | undefined,
    userTier: PricingTier,
): SimplifiedResult {
    if (!pricingPerEvent?.actorChargeEvents) return { patch: {}, noteTier: null };

    const rawEvents = Object.values(pricingPerEvent.actorChargeEvents);
    const omitDescriptions = shouldOmitEventDescriptions(rawEvents.length);
    const resolvedTiers = new Set<string>();
    const events = rawEvents.map((event) => {
        const baseEvent = {
            title: event.eventTitle,
            ...(omitDescriptions ? {} : { description: event.eventDescription || '' }),
        };

        if (typeof event.eventPriceUsd === 'number') {
            return { ...baseEvent, priceUsd: event.eventPriceUsd };
        }

        const tieredMap = event.eventTieredPricingUsd as Record<string, TieredEventPrice> | undefined;
        if (!hasTiers(tieredMap)) return baseEvent;

        const { tier, value } = resolveTier(tieredMap, userTier);
        resolvedTiers.add(tier);
        // `priceUsd` is set in addition to `tieredPricing` so the widget's FREE-tier
        // fallback (src/web/src/utils/formatting.ts) can render a concrete price for
        // FREE-tier users instead of the generic "Pay per event" fallback.
        return {
            ...baseEvent,
            priceUsd: value.tieredEventPriceUsd,
            tieredPricing: [{ tier, priceUsd: value.tieredEventPriceUsd }],
        };
    });

    const anyMultiTier = rawEvents.some((event) => hasMultipleTiers(event.eventTieredPricingUsd));
    const noteTier = anyMultiTier ? getSingleResolvedTier(resolvedTiers) : null;
    return {
        patch: {
            events,
            ...(omitDescriptions
                ? {
                    eventDescriptionsOmitted: true,
                    eventDescriptionsNote: EVENT_DESCRIPTIONS_OMITTED_NOTE,
                }
                : {}),
        },
        noteTier,
    };
}
