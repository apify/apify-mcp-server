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
 *   paidPlanPricePerUnit?: number,   // simplified only: the Store's "from" price when cheaper
 *   unitName?: string,
 *   trialMinutes?: number,
 *   tieredPricing?: [{ tier: string, pricePerUnit: number }],
 *   events?: [{
 *     title: string,
 *     description?: string,
 *     priceUsd?: number,
 *     paidPlanPriceUsd?: number,     // simplified only, on the advertised event
 *     tieredPricing?: [{ tier: string, priceUsd: number }],
 *     isPrimaryEvent?: boolean,
 *     isOneTimeEvent?: boolean,
 *   }],
 *   pricingNote?: string,
 *   eventDescriptionsOmitted?: boolean,
 *   eventDescriptionsNote?: string,
 * }
 *
 * Complete mode keeps full tier matrices (`tieredPricing` arrays), sets `userTier`,
 * and never sets `pricingNote`.
 *
 * Simplified mode resolves a single tier from each tiered map
 * (requested tier -> FREE -> first entry) and carries that resolved price in
 * `pricePerUnit` / event `priceUsd`. It drops the `tieredPricing` arrays (a single
 * resolved tier makes them redundant) and omits `userTier` (a session constant
 * returned once at the search-response top level). It emits `pricingNote` only when
 * the Actor actually has multiple tiers *and* they resolve consistently. The note names
 * the user's plan and, when a paid plan is cheaper, the price the Store page advertises
 * ("Paid plans from $X") — GOLD, else the cheapest paid tier, the same rule as the widget
 * badge. It is omitted for single-tier Actors and when PAY_PER_EVENT events resolve to
 * different tiers (no truthful single label). Text uses plan names (Free, Starter, Scale,
 * Business); structured `userTier` keeps the tier codes.
 *
 * Simplified `PAY_PER_EVENT` also trims long event lists:
 * - `events.length <= 5`: keep event descriptions
 * - `events.length > 5`: omit event descriptions and set
 *   `eventDescriptionsOmitted` / `eventDescriptionsNote`
 *
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
export type PricingTier = (typeof PRICING_TIERS)[number];

/**
 * Plan names as users see them on apify.com/pricing. PLATINUM and DIAMOND are enterprise tiers
 * with no public plan, so they keep a title-cased tier label. Text output uses these; structured
 * output keeps the tier codes (a contract consumed by apify-mcp-server-internal).
 */
const PLAN_NAME_BY_TIER: Record<PricingTier, string> = {
    FREE: 'Free',
    BRONZE: 'Starter',
    SILVER: 'Scale',
    GOLD: 'Business',
    PLATINUM: 'Platinum',
    DIAMOND: 'Diamond',
};

function getPlanName(tier: string): string {
    return PLAN_NAME_BY_TIER[tier as PricingTier] ?? tier;
}

export type ActorChargeEvent = {
    eventTitle: string;
    eventDescription?: string;
    eventPriceUsd?: number;
    eventTieredPricingUsd?: Partial<Record<PricingTier, TieredEventPrice>>;
    isPrimaryEvent?: boolean;
    /** Charged once per run (e.g. "Actor start"); quoted per run instead of per 1,000. */
    isOneTimeEvent?: boolean;
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

export type PricingInfo =
    | (ActorRunPricingInfo & {
          tieredPricing?: TieredPricing;
      })
    | PricePerEventActorPricingInfo;

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
    /** Simplified mode: the Store page's "from" price (GOLD, else cheapest paid tier) when it is below `pricePerUnit`. */
    paidPlanPricePerUnit?: number;
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
        /** Simplified mode, advertised event only: the Store's "from" price when it is below `priceUsd`. */
        paidPlanPriceUsd?: number;
        tieredPricing?: {
            tier: string;
            priceUsd: number;
        }[];
        isPrimaryEvent?: boolean;
        isOneTimeEvent?: boolean;
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

/** How a unit price is quoted in text: "per 1000 results" scales the raw per-unit price by 1000. */
type PriceQuote = {
    unit: string;
    scale: number;
};

/** The raw per-unit price the Store page advertises ("from $X"), how text quotes it, and which event it is about. */
type PaidPlanHint = {
    price: number;
    quote: PriceQuote;
    title?: string;
};

type SimplifiedResult = {
    patch: Partial<StructuredPricingInfo>;
    noteTier: string | null;
    noteHint: PaidPlanHint | null;
};

const FREE_ACTOR_TEXT = 'This Actor is free to use. You are only charged for Apify platform usage.';
const UNKNOWN_PRICING_TEXT = 'Pricing information is not available.';
const EVENTS_UNAVAILABLE_TEXT = 'Pricing information for events is not available.';
const EVENT_DESCRIPTION_LIMIT = 5;
const EVENT_DESCRIPTIONS_OMITTED_NOTE =
    'Event descriptions were omitted because this actor has many pricing events. ' +
    'Use fetch-actor-details for full pricing details.';

function resolveTier<T>(map: Record<string, T>, userTier: PricingTier): { tier: string; value: T } {
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
 * Price the public Store page advertises as "from": GOLD, else the cheapest paid tier. GOLD
 * (Business plan) is the best tier on apify.com/pricing; PLATINUM/DIAMOND are enterprise-only
 * and never shown there. Same rule as the widget badge (src/web/src/utils/formatting.ts).
 * See apify/apify-mcp-server#905.
 */
function resolveAdvertisedPrice(priceByTier: Record<string, number>): number | undefined {
    const paidTiers = Object.entries(priceByTier).filter(([tier, price]) => tier !== 'FREE' && price > 0);
    if (paidTiers.length === 0) return undefined;
    const goldPrice = paidTiers.find(([tier]) => tier === 'GOLD')?.[1];
    return goldPrice ?? Math.min(...paidTiers.map(([, price]) => price));
}

/** Currency text with 2 to 6 decimals: "$5.00", "$0.0945", "$0.00005" — sub-cent prices are never rounded to "$0.00". */
const USD_FORMAT = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
});

const PER_THOUSAND = 1000;
/** Top tier: nothing is cheaper by plan, so no upsell hint in the note or the widget. */
const TOP_TIER: PricingTier = 'DIAMOND';
const PER_RUN_QUOTE: PriceQuote = { unit: 'per run', scale: 1 };
const PER_MONTH_QUOTE: PriceQuote = { unit: 'per month', scale: 1 };

/** Results and repeatable events are quoted per 1,000, as on the Store page. */
function buildPerThousandQuote(unitLabel: string): PriceQuote {
    return { unit: `/ 1,000 ${unitLabel}`, scale: PER_THOUSAND };
}

/** One-time events ("Actor start") are charged once per run, so "per 1,000" would mislead. */
function resolveEventQuote(event: ActorChargeEvent): PriceQuote {
    return event.isOneTimeEvent ? PER_RUN_QUOTE : buildPerThousandQuote('events');
}

function formatQuotedPrice(price: number, quote: PriceQuote): string {
    return `${USD_FORMAT.format(price * quote.scale)} ${quote.unit}`;
}

/** "Free: $5.00, Business: $2.00 / 1,000 results" — plan names, the unit once at the end. */
function formatPlanPrices(priceByTier: Record<string, number>, quote: PriceQuote): string {
    const list = Object.entries(priceByTier)
        .map(([tier, price]) => `${getPlanName(tier)}: ${USD_FORMAT.format(price * quote.scale)}`)
        .join(', ');
    return `${list} ${quote.unit}`;
}

function getPriceByTier(tieredPricing: TieredPricing): Record<string, number> {
    return Object.fromEntries(
        Object.entries(tieredPricing).map(([tier, entry]) => [tier, entry.tieredPricePerUnitUsd]),
    );
}

function getEventPriceByTier(tieredMap: Record<string, TieredEventPrice>): Record<string, number> {
    return Object.fromEntries(Object.entries(tieredMap).map(([tier, entry]) => [tier, entry.tieredEventPriceUsd]));
}

/** What this user pays, with the tier it resolved to. */
type ResolvedPrice = {
    tier: string;
    price: number;
};

/**
 * The advertised price as a hint for the note and the widget, only when it undercuts what this
 * user pays. Top-tier users never get one, even if a developer priced a lower tier below theirs.
 */
function buildPaidPlanHint({
    priceByTier,
    own,
    quote,
    title,
}: {
    priceByTier: Record<string, number>;
    own: ResolvedPrice;
    quote: PriceQuote;
    title?: string;
}): PaidPlanHint | null {
    if (own.tier === TOP_TIER) return null;
    const advertised = resolveAdvertisedPrice(priceByTier);
    return advertised !== undefined && advertised < own.price ? { price: advertised, quote, title } : null;
}

function buildUnitPaidPlanHint(
    tieredPricing: TieredPricing,
    own: ResolvedPrice,
    quote: PriceQuote,
): PaidPlanHint | null {
    return buildPaidPlanHint({ priceByTier: getPriceByTier(tieredPricing), own, quote });
}

/**
 * Event whose price the Store badge advertises: the flagged primary event, else the only
 * multi-tier event. With several tiered events and no flag there is no truthful single number.
 */
function findAdvertisedEvent(events: ActorChargeEvent[]): ActorChargeEvent | undefined {
    const primaryEvent = events.find((event) => event.isPrimaryEvent);
    if (primaryEvent) return primaryEvent;
    const tieredEvents = events.filter((event) => hasMultipleTiers(event.eventTieredPricingUsd));
    return tieredEvents.length === 1 ? tieredEvents[0] : undefined;
}

function buildEventPaidPlanHint(events: ActorChargeEvent[], userTier: PricingTier): PaidPlanHint | null {
    const event = findAdvertisedEvent(events);
    const tieredMap = event?.eventTieredPricingUsd as Record<string, TieredEventPrice> | undefined;
    if (!event || !hasTiers(tieredMap)) return null;
    const resolved = resolveTier(tieredMap, userTier);
    return buildPaidPlanHint({
        priceByTier: getEventPriceByTier(tieredMap),
        own: { tier: resolved.tier, price: resolved.value.tieredEventPriceUsd },
        quote: resolveEventQuote(event),
        // With several events, say which one the number is about.
        title: events.length > 1 ? event.eventTitle : undefined,
    });
}

/**
 * Builds the simplified-mode pricing note, or returns null when no note should be shown.
 * DIAMOND is the top tier — nothing is cheaper, so the note is skipped for DIAMOND users.
 */
function buildPricingNote(resolvedTier: string, hint: PaidPlanHint | null): string | null {
    if (resolvedTier === TOP_TIER) return null;
    const about = hint?.title ? ` (${hint.title})` : '';
    const paidPlans = hint ? ` Paid plans from ${formatQuotedPrice(hint.price, hint.quote)}${about}.` : '';
    return `Prices shown are for the ${getPlanName(resolvedTier)} plan.${paidPlans} Use fetch-actor-details for the full pricing table.`;
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

/** Resolves the single price of a unit model: its only tier, else the flat price. */
function getSingleUnitPrice(info: DatasetItemLike | RentalLike): number {
    const [onlyTier] = info.tieredPricing ? Object.values(info.tieredPricing) : [];
    return onlyTier?.tieredPricePerUnitUsd ?? info.pricePerUnitUsd ?? 0;
}

function formatDatasetItemComplete(info: DatasetItemLike): string {
    const quote = buildPerThousandQuote(info.unitName ? `${info.unitName}s` : 'results');
    if (hasTiers(info.tieredPricing) && hasMultipleTiers(info.tieredPricing)) {
        return `This Actor has tiered pricing: ${formatPlanPrices(getPriceByTier(info.tieredPricing), quote)}.`;
    }
    return `This Actor costs ${formatQuotedPrice(getSingleUnitPrice(info), quote)}.`;
}

function formatRentalComplete(info: RentalLike): string {
    const { value, unit } = convertMinutesToGreatestUnit(info.trialMinutes || 0);
    const trial = `with a trial period of ${value} ${unit}.`;
    if (hasTiers(info.tieredPricing) && hasMultipleTiers(info.tieredPricing)) {
        const plans = formatPlanPrices(getPriceByTier(info.tieredPricing), PER_MONTH_QUOTE);
        return `This Actor is rental and has tiered pricing: ${plans}, ${trial}`;
    }
    return `This Actor is rental and costs ${formatQuotedPrice(getSingleUnitPrice(info), PER_MONTH_QUOTE)}, ${trial}`;
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
    const quote = resolveEventQuote(event);
    if (typeof event.eventPriceUsd === 'number') return formatQuotedPrice(event.eventPriceUsd, quote);
    const tiered = event.eventTieredPricingUsd as Record<string, TieredEventPrice> | undefined;
    if (!hasTiers(tiered)) return 'No price info';
    if (hasMultipleTiers(tiered)) return formatPlanPrices(getEventPriceByTier(tiered), quote);
    const [price] = Object.values(tiered);
    return formatQuotedPrice(price.tieredEventPriceUsd, quote);
}

/** Complete structured contract used by `fetch-actor-details`. */
export function pricingInfoToStructured(pricingInfo: PricingInfo | null, userTier: PricingTier): StructuredPricingInfo {
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

function createStructuredBase(pricingInfo: PricingInfo | null, userTier: PricingTier): StructuredPricingInfo {
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
                ? Object.entries(event.eventTieredPricingUsd).map(([tier, price]) => ({
                      tier,
                      priceUsd: (price as TieredEventPrice).tieredEventPriceUsd,
                  }))
                : undefined,
            ...(event.isPrimaryEvent ? { isPrimaryEvent: true } : {}),
            ...(event.isOneTimeEvent ? { isOneTimeEvent: true } : {}),
        })),
    };
}

/** Simplified text contract used by `search-actors`. */
export function pricingInfoToSimplifiedString(pricingInfo: PricingInfo | null, userTier: PricingTier): string {
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
    const quote = buildPerThousandQuote(info.unitName ? `${info.unitName}s` : 'results');
    if (hasTiers(info.tieredPricing)) {
        const { tier, value } = resolveTier(info.tieredPricing, userTier);
        const base = `This Actor costs ${formatQuotedPrice(value.tieredPricePerUnitUsd, quote)}.`;
        const hint = buildUnitPaidPlanHint(info.tieredPricing, { tier, price: value.tieredPricePerUnitUsd }, quote);
        const note = hasMultipleTiers(info.tieredPricing) ? buildPricingNote(tier, hint) : null;
        return note ? `${base} ${note}` : base;
    }
    return `This Actor costs ${formatQuotedPrice(info.pricePerUnitUsd ?? 0, quote)}.`;
}

function formatRentalSimplified(info: RentalLike, userTier: PricingTier): string {
    const { value, unit } = convertMinutesToGreatestUnit(info.trialMinutes || 0);
    const trial = `with a trial period of ${value} ${unit}.`;
    if (hasTiers(info.tieredPricing)) {
        const { tier, value: entry } = resolveTier(info.tieredPricing, userTier);
        const base = `This Actor is rental and costs ${formatQuotedPrice(entry.tieredPricePerUnitUsd, PER_MONTH_QUOTE)}, ${trial}`;
        const hint = buildUnitPaidPlanHint(
            info.tieredPricing,
            { tier, price: entry.tieredPricePerUnitUsd },
            PER_MONTH_QUOTE,
        );
        const note = hasMultipleTiers(info.tieredPricing) ? buildPricingNote(tier, hint) : null;
        return note ? `${base} ${note}` : base;
    }
    return `This Actor is rental and costs ${formatQuotedPrice(info.pricePerUnitUsd ?? 0, PER_MONTH_QUOTE)}, ${trial}`;
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

        const detail = typeof price === 'number' ? formatQuotedPrice(price, resolveEventQuote(event)) : 'No price info';
        if (omitDescriptions) return `  - **${event.eventTitle}**: ${detail}`;
        return `  - **${event.eventTitle}**: ${event.eventDescription ?? ''} (${detail})`;
    });

    const body = `This Actor is paid per event:\n${eventLines.join('\n')}`;
    const anyMultiTier = events.some((event) => hasMultipleTiers(event.eventTieredPricingUsd));
    const noteTier = anyMultiTier ? getSingleResolvedTier(resolvedTiers) : null;
    const pricingNote = noteTier ? buildPricingNote(noteTier, buildEventPaidPlanHint(events, userTier)) : null;
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
    // Simplified mode (search-actors) omits `userTier` from each pricing block — it is a
    // session constant returned once at the search-response top level, not per Actor.
    const base: StructuredPricingInfo = { model: pricingInfo?.pricingModel || ACTOR_PRICING_MODEL.FREE };
    if (isFreeActor(pricingInfo)) return base;

    const { patch, noteTier, noteHint } = resolveSimplifiedPatch(pricingInfo, userTier);
    const pricingNote = noteTier ? buildPricingNote(noteTier, noteHint) : null;
    return {
        ...base,
        ...patch,
        ...(pricingNote ? { pricingNote } : {}),
    };
}

function resolveSimplifiedPatch(pricingInfo: PricingInfo, userTier: PricingTier): SimplifiedResult {
    switch (pricingInfo.pricingModel) {
        case ACTOR_PRICING_MODEL.PRICE_PER_DATASET_ITEM: {
            const unitLabel = pricingInfo.unitName ? `${pricingInfo.unitName}s` : 'results';
            const r = structureTieredUnitSimplified(pricingInfo, userTier, buildPerThousandQuote(unitLabel));
            return { ...r, patch: { unitName: pricingInfo.unitName || 'result', ...r.patch } };
        }
        case ACTOR_PRICING_MODEL.FLAT_PRICE_PER_MONTH: {
            const r = structureTieredUnitSimplified(pricingInfo, userTier, PER_MONTH_QUOTE);
            return { ...r, patch: { trialMinutes: pricingInfo.trialMinutes, ...r.patch } };
        }
        case ACTOR_PRICING_MODEL.PAY_PER_EVENT:
            return structurePayPerEventSimplified(pricingInfo.pricingPerEvent, userTier);
        default:
            return { patch: {}, noteTier: null, noteHint: null };
    }
}

function structureTieredUnitSimplified(
    info: DatasetItemLike | RentalLike,
    userTier: PricingTier,
    quote: PriceQuote,
): SimplifiedResult {
    const patch: Partial<StructuredPricingInfo> = { pricePerUnit: info.pricePerUnitUsd ?? 0 };
    if (hasTiers(info.tieredPricing)) {
        const { tier, value } = resolveTier(info.tieredPricing, userTier);
        // Simplified mode resolves to one tier; the resolved price lives in `pricePerUnit`,
        // so the 1-element `tieredPricing` array just duplicates it. Drop it.
        patch.pricePerUnit = value.tieredPricePerUnitUsd;
        const noteHint = buildUnitPaidPlanHint(info.tieredPricing, { tier, price: value.tieredPricePerUnitUsd }, quote);
        if (noteHint) patch.paidPlanPricePerUnit = noteHint.price;
        return { patch, noteTier: hasMultipleTiers(info.tieredPricing) ? tier : null, noteHint };
    }
    return { patch, noteTier: null, noteHint: null };
}

function structurePayPerEventSimplified(
    pricingPerEvent: { actorChargeEvents: Record<string, ActorChargeEvent> } | undefined,
    userTier: PricingTier,
): SimplifiedResult {
    if (!pricingPerEvent?.actorChargeEvents) return { patch: {}, noteTier: null, noteHint: null };

    const rawEvents = Object.values(pricingPerEvent.actorChargeEvents);
    const omitDescriptions = shouldOmitEventDescriptions(rawEvents.length);
    const advertisedEvent = findAdvertisedEvent(rawEvents);
    const noteHint = buildEventPaidPlanHint(rawEvents, userTier);
    const resolvedTiers = new Set<string>();
    const events = rawEvents.map((event) => {
        const baseEvent = {
            title: event.eventTitle,
            ...(omitDescriptions ? {} : { description: event.eventDescription || '' }),
            ...(event.isPrimaryEvent ? { isPrimaryEvent: true as const } : {}),
            ...(event.isOneTimeEvent ? { isOneTimeEvent: true as const } : {}),
        };

        if (typeof event.eventPriceUsd === 'number') {
            return { ...baseEvent, priceUsd: event.eventPriceUsd };
        }

        const tieredMap = event.eventTieredPricingUsd as Record<string, TieredEventPrice> | undefined;
        if (!hasTiers(tieredMap)) return baseEvent;

        const { tier, value } = resolveTier(tieredMap, userTier);
        resolvedTiers.add(tier);
        // Simplified mode resolves to one tier; `priceUsd` carries the resolved price,
        // so the 1-element `tieredPricing` array just duplicates it. Drop it.
        return {
            ...baseEvent,
            priceUsd: value.tieredEventPriceUsd,
            ...(event === advertisedEvent && noteHint ? { paidPlanPriceUsd: noteHint.price } : {}),
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
        noteHint,
    };
}
