import { ApifyApiError } from 'apify-client';

import log from '@apify/log';

import type { ApifyClient } from '../apify_client.js';
import { HTTP_PAYMENT_REQUIRED } from '../const.js';

const PAYMENT_REQUIRED_HEADER = 'payment-required';

/**
 * Symbol used to attach captured payment-required header data to errors.
 * The axios response interceptor stores the header value here so it can be
 * forwarded in McpError.data without modifying the apify-client SDK.
 */
const PAYMENT_REQUIRED_DATA = Symbol.for('paymentRequiredData');

type ErrorWithPaymentData = Error & { [PAYMENT_REQUIRED_DATA]?: Record<string, unknown> };

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
    // Access the internal axios instance: ApifyClient -> HttpClient -> AxiosInstance
    // Wrapped in try-catch because this accesses private internals that may change
    let axiosInstance;
    try {
        axiosInstance = (apifyClient as unknown as { httpClient: { axios: { interceptors: {
            response: { use: (onFulfilled: null, onRejected: (error: unknown) => unknown) => void };
        } } } }).httpClient.axios;
        if (!axiosInstance?.interceptors?.response?.use) throw new Error('axios interceptors not found');
    } catch {
        log.warning('[x402] Failed to access apify-client axios internals — payment header capture disabled');
        return;
    }

    // eslint-disable-next-line @typescript-eslint/promise-function-async -- axios interceptors must return a rejected promise, not throw
    axiosInstance.interceptors.response.use(null, (error: unknown) => {
        if (
            typeof error === 'object'
            && error !== null
            && 'response' in error
        ) {
            const { response } = error as { response?: { status?: number; headers?: Record<string, string> } };
            if (response?.status === HTTP_PAYMENT_REQUIRED && response.headers) {
                const headerValue = response.headers[PAYMENT_REQUIRED_HEADER];
                if (typeof headerValue === 'string' && headerValue.length > 0) {
                    try {
                        const decoded = JSON.parse(Buffer.from(headerValue, 'base64').toString('utf-8'));
                        Object.defineProperty(error, PAYMENT_REQUIRED_DATA, { value: decoded, enumerable: false });
                    } catch {
                        // Header wasn't valid base64 JSON — ignore
                    }
                }
            }
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
export function extractPaymentRequiredData(error: unknown): Record<string, unknown> | undefined {
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
