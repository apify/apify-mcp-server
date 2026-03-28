import { SkyfirePaymentProvider } from './skyfire.js';
import type { PaymentProvider, PaymentProviderId } from './types.js';
import { X402PaymentProvider } from './x402.js';

/**
 * Resolves a payment provider from a `?payment=` query parameter value.
 *
 * Some providers require async initialization (e.g., fetching payment requirements
 * from the Apify API), so this function is async.
 *
 * @returns A PaymentProvider instance, or undefined if the value is not a known provider.
 */
export async function resolvePaymentProvider(paymentParam: string | null | undefined): Promise<PaymentProvider | undefined> {
    if (!paymentParam) return undefined;

    const providers: Record<PaymentProviderId, () => Promise<PaymentProvider>> = {
        skyfire: async () => SkyfirePaymentProvider.create(),
        x402: async () => X402PaymentProvider.create(),
    };

    const factory = providers[paymentParam as PaymentProviderId];
    return factory?.();
}
