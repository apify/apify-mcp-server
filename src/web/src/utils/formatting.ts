import pluralize from 'pluralize';

import type { StructuredPricingInfo } from '../types';

const PRICE_DISPLAY_UNIT_SIZE = 1000;
const PAID_PLAN_HINT_SUFFIX = 'on paid plans';

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

/** Badge prices show 2 to 6 decimals so sub-cent per-1,000 prices ("$0.0945") are not rounded away. */
function formatBadgePrice(price: number): string {
    return formatPriceUsd(price, { maximumFractionDigits: 6 });
}

/**
 * Appends the Store page's "from" price as an upgrade hint. The server sets the paid-plan price
 * only when a paid plan is cheaper than what this user pays, so presence alone decides.
 * See apify/apify-mcp-server#905.
 */
function formatWithPaidPlanHint(badge: string, paidPlanPrice: number | undefined, scale: number): string {
    if (paidPlanPrice === undefined) return badge;
    return `${badge} · from ${formatBadgePrice(paidPlanPrice * scale)} ${PAID_PLAN_HINT_SUFFIX}`;
}

function formatFlatPricePerMonth(pricing: StructuredPricingInfo): string {
    const badge = `${formatBadgePrice(pricing.pricePerUnit || 0)}/month + usage`;
    return formatWithPaidPlanHint(badge, pricing.paidPlanPricePerUnit, 1);
}

/** Repeatable events are quoted per 1,000 like the Store page; one-time events ("Actor start") per run. */
function formatPayPerEventPricing(event: NonNullable<StructuredPricingInfo['events']>[0]): string {
    if (typeof event.priceUsd !== 'number') return 'Pay per event';
    if (event.isOneTimeEvent) {
        return formatWithPaidPlanHint(`${formatBadgePrice(event.priceUsd)} per run`, event.paidPlanPriceUsd, 1);
    }
    const title = event.title.toLowerCase() || 'result';
    const badge = `${formatBadgePrice(event.priceUsd * PRICE_DISPLAY_UNIT_SIZE)} / 1,000 ${pluralize(title, PRICE_DISPLAY_UNIT_SIZE)}`;
    return formatWithPaidPlanHint(badge, event.paidPlanPriceUsd, PRICE_DISPLAY_UNIT_SIZE);
}

function formatPricePerDatasetItem(pricing: StructuredPricingInfo): string {
    const pluralUnitName = pluralize(pricing.unitName || 'result');
    const badge = `${formatBadgePrice((pricing.pricePerUnit || 0) * PRICE_DISPLAY_UNIT_SIZE)} / 1,000 ${pluralUnitName}`;
    return formatWithPaidPlanHint(badge, pricing.paidPlanPricePerUnit, PRICE_DISPLAY_UNIT_SIZE);
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

        return primaryEvent ? formatPayPerEventPricing(primaryEvent) : 'Pay per event';
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
