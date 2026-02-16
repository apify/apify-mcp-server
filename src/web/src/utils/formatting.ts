import pluralize from 'pluralize';

import type {StructuredPricingInfo} from '../types';

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

function formatFlatPricePerMonth(pricePerUnit: number | undefined): string {
    const monthlyPrice = pricePerUnit || 0;
    return `${formatPriceUsd(monthlyPrice)}/month + usage`;
}

function formatPayPerEventPricing(event: NonNullable<StructuredPricingInfo['events']>[0]): string {
    const title = event.title.toLowerCase() || 'result';

    if (event.tieredPricing && event.tieredPricing.length > 0) {
        const tieredPrices = event.tieredPricing
            .filter(tier => tier.tier !== 'FREE' && tier.priceUsd > 0)
            .map(tier => tier.priceUsd);

        if (tieredPrices.length > 0) {
            const minPrice = Math.min(...tieredPrices);
            const pricePerThousand = minPrice * PRICE_DISPLAY_UNIT_SIZE;
            return `from ${formatPriceUsd(pricePerThousand)} / 1,000 ${pluralize(title, PRICE_DISPLAY_UNIT_SIZE)}`;
        }
    }

    if (typeof event.priceUsd === 'number') {
        const isPricedPerThousandResults = event.priceUsd < PER_THOUSAND_PRICING_THRESHOLD;

        if (isPricedPerThousandResults) {
            const pricePerThousand = event.priceUsd * PRICE_DISPLAY_UNIT_SIZE;
            return `${formatPriceUsd(pricePerThousand)} / 1,000 ${pluralize(title, PRICE_DISPLAY_UNIT_SIZE)}`;
        }
        return `${formatPriceUsd(event.priceUsd)} / ${title}`;
    }

    return 'Pay per event';
}

function formatPricePerDatasetItem(pricing: StructuredPricingInfo): string {
    const unitName = pricing.unitName || 'result';
    const pluralUnitName = pluralize(unitName);

    if (pricing.tieredPricing && pricing.tieredPricing.length > 0) {
        const tieredPrices = pricing.tieredPricing
            .filter(tier => tier.tier !== 'FREE')
            .map(tier => tier.pricePerUnit)
            .filter(price => price > 0);

        if (tieredPrices.length > 0) {
            const minPrice = Math.min(...tieredPrices);
            const pricePerThousand = minPrice * PRICE_DISPLAY_UNIT_SIZE;
            return `from ${formatPriceUsd(pricePerThousand)} / 1,000 ${pluralUnitName}`;
        }
    }

    const pricePerUnit = pricing.pricePerUnit || 0;
    const pricePerThousand = pricePerUnit * PRICE_DISPLAY_UNIT_SIZE;
    return `from ${formatPriceUsd(pricePerThousand)} / 1,000 ${pluralUnitName}`;
}

export const formatPricing = (pricing: StructuredPricingInfo): string => {
    if (!pricing) {
        return 'Pay per usage';
    }

    if (pricing.model === 'FLAT_PRICE_PER_MONTH') {
        return formatFlatPricePerMonth(pricing.pricePerUnit);
    }

    if (pricing.model === 'PAY_PER_EVENT') {
        if (!pricing.events || pricing.events.length === 0) {
            return 'Pay per event';
        }

        if (pricing.events.length === 1) {
            return formatPayPerEventPricing(pricing.events[0]);
        }

        return 'Pay per event';
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
