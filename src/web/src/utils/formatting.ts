import { PricingInfo } from '../types';

export const getPricingInfo = (pricing: PricingInfo): { value: string, additionalInfo?: string } => {
    if (pricing.pricingModel === "FREE") return { value: "Free" };
    if (pricing.pricingModel === "FLAT_PRICE_PER_MONTH") {
        return { value: `$${pricing.monthlyChargeUsd}`, additionalInfo: "per month" };
    }
    if (pricing.pricingModel === "PRICE_PER_DATASET_ITEM") {
        return { value: `$${pricing.pricePerResultUsd}`, additionalInfo: "per result" };
    }
    if (pricing.pricingModel === "PAY_PER_EVENT") {
        return { value: "Pay per use" };
    }
    return { value: "N/A" };
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
