import { ApifyApiError } from 'apify-client';

import log from '@apify/log';

import type { ApifyClient } from '../apify_client.js';
import { HTTP_PAYMENT_REQUIRED } from '../const.js';
import { buildMCPResponse } from './mcp.js';

const PAYMENT_REQUIRED_HEADER = 'payment-required';

/**
 * Symbol used to attach captured payment-required header data to errors.
 * The axios response interceptor stores the header value here so it can be
 * forwarded as x402 payment data without modifying the apify-client SDK.
 */
const PAYMENT_REQUIRED_DATA = Symbol.for('paymentRequiredData');

type ErrorWithPaymentData = Error & { [PAYMENT_REQUIRED_DATA]?: Record<string, unknown> };

type AxiosInstanceLike = {
    interceptors?: {
        response?: {
            use?: (onFulfilled: null, onRejected: (error: unknown) => unknown) => void;
        };
    };
};

function getAxiosInstance(apifyClient: ApifyClient): AxiosInstanceLike | undefined {
    return (apifyClient as unknown as { httpClient?: { axios?: AxiosInstanceLike } }).httpClient?.axios;
}

function decodePaymentRequiredHeader(headerValue: unknown): Record<string, unknown> | undefined {
    if (typeof headerValue !== 'string' || headerValue.length === 0) return undefined;
    try {
        return JSON.parse(Buffer.from(headerValue, 'base64').toString('utf-8')) as Record<string, unknown>;
    } catch {
        return undefined;
    }
}

/**
 * Registers an axios response error interceptor on the ApifyClient's internal
 * HTTP client. When a 402 response is received, the interceptor captures the
 * base64-encoded `payment-required` header, decodes it, and attaches the parsed
 * object to the error via a Symbol property.
 *
 * This is intentionally "hacky" — apify-client does not expose response headers
 * on errors, so we reach into the internal axios instance.
 */
export function registerPaymentRequiredInterceptor(apifyClient: ApifyClient): void {
    const axiosInstance = getAxiosInstance(apifyClient);

    if (!axiosInstance?.interceptors?.response?.use) {
        log.warning('[x402] Failed to access apify-client axios internals — payment header capture disabled');
        return;
    }

    // eslint-disable-next-line @typescript-eslint/promise-function-async -- axios interceptors must return a rejected promise, not throw
    axiosInstance.interceptors.response.use(null, (error: unknown) => {
        const response = (error as { response?: { status?: number; headers?: Record<string, string> } })?.response;
        const paymentData = response?.status === HTTP_PAYMENT_REQUIRED
            ? decodePaymentRequiredHeader(response.headers?.[PAYMENT_REQUIRED_HEADER])
            : undefined;

        if (paymentData) {
            Object.defineProperty(error as object, PAYMENT_REQUIRED_DATA, { value: paymentData, enumerable: false });
        }

        return Promise.reject(error);
    });
}

/**
 * Extracts payment-required data from an error thrown by the ApifyClient.
 *
 * Checks two sources in priority order:
 * 1. The captured `payment-required` response header (via axios interceptor)
 * 2. The `data` field on ApifyApiError (from the API response body)
 */
function extractPaymentRequiredData(error: unknown): Record<string, unknown> | undefined {
    if (typeof error !== 'object' || error === null) return undefined;

    // Source 1: Captured payment-required header (set by our interceptor)
    const captured = (error as ErrorWithPaymentData)[PAYMENT_REQUIRED_DATA];
    if (captured && typeof captured === 'object') return captured;

    // Source 2: ApifyApiError.data (API response body) — only trust genuine Apify API errors
    if (error instanceof ApifyApiError) {
        const { data } = error;
        if (typeof data === 'object' && data !== null) return data as Record<string, unknown>;
    }

    return undefined;
}

/**
 * Builds an MCP response for a 402 Payment Required error.
 * Formats the response as a tool result containing the PaymentRequired JSON
 * per the x402 MCP transport spec, which allows clients to automatically handle the payment flow.
 */
export function buildPaymentRequiredResponse(errorOrMessage: unknown, precomputedPaymentData?: unknown) {
    const paymentData = precomputedPaymentData ?? extractPaymentRequiredData(errorOrMessage);
    const message = errorOrMessage instanceof Error ? errorOrMessage.message : String(errorOrMessage);

    return buildMCPResponse({
        texts: [paymentData ? JSON.stringify(paymentData) : message],
        isError: true,
    });
}
