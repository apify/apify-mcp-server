import pluralize from 'pluralize';

import {StructuredPricingInfo} from '../types';

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

    const {
        minimumFractionDigits,
        maximumFractionDigits,
    } = options;
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

export const formatPricing = (pricing: StructuredPricingInfo): string => {
    // Handle PAY_PER_USAGE case (undefined input)
    if (!pricing) {
        return 'Pay per usage';
    }

    // Handle RENTAL case - FLAT_PRICE_PER_MONTH
    if (pricing.model === 'FLAT_PRICE_PER_MONTH') {
        const monthlyPrice = pricing.pricePerUnit || 0;
        return `${formatPriceUsd(monthlyPrice)}/month + usage`;
    }

    // Handle PAY_PER_EVENT case - PAY_PER_EVENT
    if (pricing.model === 'PAY_PER_EVENT') {
        if (!pricing.events || pricing.events.length === 0) {
            return 'Pay per event';
        }

        // PPE has only one event
        if (pricing.events.length === 1) {
            const event = pricing.events[0];

            // Check if it's a tiered pricing event
            if (event.tieredPricing && event.tieredPricing.length > 0) {
                // Find the lowest non-zero price (excluding FREE tier if present)
                const tieredPrices = event.tieredPricing
                    .filter(tier => tier.tier !== 'FREE' && tier.priceUsd > 0)
                    .map(tier => tier.priceUsd);

                if (tieredPrices.length > 0) {
                    const minPrice = Math.min(...tieredPrices);
                    const title = event.title.toLowerCase() || 'result';
                    // Assume per-thousand pricing for most events (can be refined based on event type)
                    const pricePerThousand = minPrice * 1000;
                    return `from ${formatPriceUsd(pricePerThousand)} / 1,000 ${pluralize(title, 1000)}`;
                }
            }

            // Flat pricing for single event
            if (typeof event.priceUsd === 'number') {
                const title = event.title.toLowerCase() || 'result';
                // Determine if it's per-thousand or per-unit based on price magnitude
                const isPricedPerThousandResults = event.priceUsd < 0.01; // Heuristic: very small prices are likely per-unit

                if (isPricedPerThousandResults) {
                    const pricePerThousand = event.priceUsd * 1000;
                    return `${formatPriceUsd(pricePerThousand)} / 1,000 ${pluralize(title, 1000)}`;
                } else {
                    return `${formatPriceUsd(event.priceUsd)} / ${title}`;
                }
            }
        }

        return 'Pay per event';
    }

    // Handle PAY_PER_RESULT case - PRICE_PER_DATASET_ITEM
    if (pricing.model === 'PRICE_PER_DATASET_ITEM') {
        const unitName = pricing.unitName || 'result';
        const pluralUnitName = pluralize(unitName);

        // Check if tiered pricing exists
        if (pricing.tieredPricing && pricing.tieredPricing.length > 0) {
            // Find the lowest price from tiered pricing (excluding FREE tier)
            const tieredPrices = pricing.tieredPricing
                .filter(tier => tier.tier !== 'FREE')
                .map(tier => tier.pricePerUnit)
                .filter(price => price > 0);

            if (tieredPrices.length > 0) {
                const minPrice = Math.min(...tieredPrices);
                const pricePerThousand = minPrice * 1000;
                return `from ${formatPriceUsd(pricePerThousand)} / 1,000 ${pluralUnitName}`;
            }
        }

        // Use regular price per unit
        const pricePerUnit = pricing.pricePerUnit || 0;
        const pricePerThousand = pricePerUnit * 1000;
        return `from ${formatPriceUsd(pricePerThousand)} / 1,000 ${pluralUnitName}`;
    }

    // Default fallback
    return 'Pay per usage';
};

export const formatNumber = (num: number): string => {
    try {
        if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
        if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
        return num.toString();
    } catch (error) {
        console.error("Error formatting number:", error);
        return "N/A";
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
