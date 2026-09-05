import pluralize from 'pluralize';

import type { StructuredPricingInfo } from '../types';

const PER_THOUSAND_PRICING_THRESHOLD = 0.01;
const PRICE_DISPLAY_UNIT_SIZE = 1000;

type FormatPriceUsdOptions = {
    decimals?: number;
    fullCurrencyCode?: boolean;
    minimumFractionDigits?: number;
    maximumFractionDigits?: number;
};

export function formatNumberWithOptions(number: number, intlOptions: Intl.NumberFormatOptions = {}) {
    return new Intl.NumberFormat('en-US', {
        useGrouping: true,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
        ...intlOptions,
    }).format(number || 0);
}

export function formatPrice(amount = 0, intlOptions: Intl.NumberFormatOptions = {}) {
    const formattedAmount = formatNumberWithOptions(amount, intlOptions);
    return `${formattedAmount} ${intlOptions.currency || ''}`.trim();
}

/**
 * Converts a number to a string in USD format, e.g. 123456.78 to "$123,456.79".
 *
 * @param options.decimals Number of digits behind the decimal point. By default 2.
 * @param options.fullCurrencyCode If true, the function will return "123,456.79 USD" instead of "$123,456.79".
 */
export function formatPriceUsd(price: number, options: FormatPriceUsdOptions = {}) {
    const { decimals, fullCurrencyCode, ...rest } = options;

    const { minimumFractionDigits, maximumFractionDigits } = options;
    const defaultMinimumFractionDigits = Number.isInteger(decimals) ? decimals : 2;
    const defaultMaximumFractionDigits = Number.isInteger(decimals) ? decimals : 2;

    const intlOptions = {
        minimumFractionDigits: minimumFractionDigits ?? defaultMinimumFractionDigits,
        maximumFractionDigits: maximumFractionDigits ?? defaultMaximumFractionDigits,
        currency: 'USD',
        ...rest,
    };

    if (fullCurrencyCode) return `${formatPrice(price, intlOptions)}`;

    return formatNumberWithOptions(price, { style: 'currency', ...intlOptions }); // Intl will return the format we want: i.e. -$123,323.21;
}

type TierPrice = { tier: string; price: number };

/**
 * What this user pays: their tier, else FREE, else the first entry — the same fallback order as
 * the server's `resolveTier` in src/utils/pricing_info.ts. Anonymous users resolve as FREE.
 */
function resolveUserTierPrice(tiers: TierPrice[], userTier = 'FREE'): number | undefined {
    const priceByTier = new Map(tiers.map(({ tier, price }) => [tier, price]));
    return priceByTier.get(userTier) ?? priceByTier.get('FREE') ?? tiers[0]?.price;
}

/**
 * What the public Store badge advertises: GOLD, else the cheapest paid tier.
 * GOLD (Business plan) is the best tier listed on apify.com/pricing; PLATINUM/DIAMOND are
 * enterprise-only and the Store never shows them. See apify/apify-mcp-server#905.
 */
function resolveStoreBadgeTierPrice(tiers: TierPrice[]): number | undefined {
    const paidTiers = tiers.filter(({ tier, price }) => tier !== 'FREE' && price > 0);
    if (paidTiers.length === 0) return undefined;
    const goldPrice = paidTiers.find(({ tier }) => tier === 'GOLD')?.price;
    return goldPrice ?? Math.min(...paidTiers.map(({ price }) => price));
}

/**
 * Badge for a tiered price: what this user pays, plus the Store's "from" price as an upgrade hint
 * when a paid plan is cheaper. The Store page shows "from GOLD" because it does not know the
 * visitor; the widget does, so it shows both. A $0 tier is a real price ("free for you") and is
 * rendered; only an empty matrix returns undefined so callers fall back to their flat-price path.
 * See apify/apify-mcp-server#905.
 */
function formatTieredPrice({
    tiers,
    userTier,
    scale,
    toBadge,
}: {
    tiers: TierPrice[];
    userTier: string | undefined;
    scale: number;
    toBadge: (amount: string) => string;
}): string | undefined {
    const ownPrice = resolveUserTierPrice(tiers, userTier);
    if (ownPrice === undefined) return undefined;
    const storePrice = resolveStoreBadgeTierPrice(tiers);
    const hint =
        storePrice !== undefined && storePrice < ownPrice
            ? ` · from ${formatPriceUsd(storePrice * scale)} on paid plans`
            : '';
    return `${toBadge(formatPriceUsd(ownPrice * scale))}${hint}`;
}

function formatFlatPricePerMonth(pricing: StructuredPricingInfo): string {
    // Complete-mode `pricePerUnit` is the un-resolved base price; tiered rentals must resolve the tier.
    const tieredBadge = pricing.tieredPricing
        ? formatTieredPrice({
              tiers: pricing.tieredPricing.map(({ tier, pricePerUnit }) => ({ tier, price: pricePerUnit })),
              userTier: pricing.userTier,
              scale: 1,
              toBadge: (amount) => `${amount}/month + usage`,
          })
        : undefined;
    return tieredBadge ?? `${formatPriceUsd(pricing.pricePerUnit || 0)}/month + usage`;
}

function formatPayPerEventPricing(
    event: NonNullable<StructuredPricingInfo['events']>[0],
    userTier: string | undefined,
): string {
    const title = event.title.toLowerCase() || 'result';
    const perThousand = (amount: string) => `${amount} / 1,000 ${pluralize(title, PRICE_DISPLAY_UNIT_SIZE)}`;

    if (event.tieredPricing) {
        const tieredBadge = formatTieredPrice({
            tiers: event.tieredPricing.map(({ tier, priceUsd }) => ({ tier, price: priceUsd })),
            userTier,
            scale: PRICE_DISPLAY_UNIT_SIZE,
            toBadge: perThousand,
        });
        if (tieredBadge) return tieredBadge;
    }

    if (typeof event.priceUsd === 'number') {
        const isPricedPerThousandResults = event.priceUsd < PER_THOUSAND_PRICING_THRESHOLD;
        if (isPricedPerThousandResults) return perThousand(formatPriceUsd(event.priceUsd * PRICE_DISPLAY_UNIT_SIZE));
        return `${formatPriceUsd(event.priceUsd)} / ${title}`;
    }

    return 'Pay per event';
}

function formatPricePerDatasetItem(pricing: StructuredPricingInfo): string {
    const pluralUnitName = pluralize(pricing.unitName || 'result');
    const perThousand = (amount: string) => `${amount} / 1,000 ${pluralUnitName}`;

    if (pricing.tieredPricing) {
        const tieredBadge = formatTieredPrice({
            tiers: pricing.tieredPricing.map(({ tier, pricePerUnit }) => ({ tier, price: pricePerUnit })),
            userTier: pricing.userTier,
            scale: PRICE_DISPLAY_UNIT_SIZE,
            toBadge: perThousand,
        });
        if (tieredBadge) return tieredBadge;
    }

    return perThousand(formatPriceUsd((pricing.pricePerUnit || 0) * PRICE_DISPLAY_UNIT_SIZE));
}

export const formatPricing = (pricing: StructuredPricingInfo): string => {
    if (!pricing) {
        return 'Pay per usage';
    }

    if (pricing.model === 'FLAT_PRICE_PER_MONTH') {
        return formatFlatPricePerMonth(pricing);
    }

    if (pricing.model === 'PAY_PER_EVENT') {
        if (!pricing.events || pricing.events.length === 0) {
            return 'Pay per event';
        }

        // The Store badge shows the API's primary event, not a generic label; see apify/apify-mcp-server#905.
        const primaryEvent =
            pricing.events.length === 1 ? pricing.events[0] : pricing.events.find((event) => event.isPrimaryEvent);

        return primaryEvent ? formatPayPerEventPricing(primaryEvent, pricing.userTier) : 'Pay per event';
    }

    if (pricing.model === 'PRICE_PER_DATASET_ITEM') {
        return formatPricePerDatasetItem(pricing);
    }

    return 'Pay per usage';
};

export const formatNumber = (num: number): string => {
    try {
        if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
        if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
        return num.toString();
    } catch (error) {
        console.error('Error formatting number:', error);
        return 'N/A';
    }
};

export const formatDuration = (startedAt: string, finishedAt?: string): string => {
    const start = new Date(startedAt).getTime();
    const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
    const durationMs = end - start;

    const seconds = Math.floor(durationMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
        return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    }
    if (minutes > 0) {
        return `${minutes}m ${seconds % 60}s`;
    }
    return `${seconds}s`;
};

export const formatBytes = (bytes: number): string => {
    if (bytes >= 1024 * 1024 * 1024) {
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }
    if (bytes >= 1024 * 1024) {
        return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    }
    if (bytes >= 1024) {
        return `${(bytes / 1024).toFixed(2)} KB`;
    }
    return `${bytes} B`;
};

export const formatDecimalNumber = (value: number): string => {
    if (Number.isInteger(value)) {
        return value.toString();
    }
    return value.toFixed(1);
};

export const formatTimestamp = (dateString: string): string => {
    const date = new Date(dateString);

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');

    return `${year}-${month}-${day} ${hours}:${minutes}`;
};

/**
 * Converts a technical name (kebab-case) to a human-readable format (Title Case).
 * Example: "python-example" -> "Python Example"
 *
 * @param technicalName - The technical name to humanize (e.g., "my-actor-name")
 * @returns The humanized name with each word capitalized (e.g., "My Actor Name")
 */
export const humanizeActorName = (technicalName: string): string => {
    return technicalName
        .split('-')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
};
