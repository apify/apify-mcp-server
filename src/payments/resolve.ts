import { SkyfirePaymentProvider } from './skyfire.js';
import type { PaymentProvider, PaymentProviderId } from './types.js';
import { X402PaymentProvider } from './x402.js';

/**
 * Resolves a payment provider from a `?payment=` query parameter value.
 *
 * @returns A PaymentProvider instance, or undefined if the value is not a known provider.
 */
export function resolvePaymentProvider(paymentParam: string | null | undefined): PaymentProvider | undefined {
    if (!paymentParam) return undefined;

    const providers: Record<PaymentProviderId, () => PaymentProvider> = {
        skyfire: () => new SkyfirePaymentProvider(),
        x402: () => new X402PaymentProvider(),
    };

    const factory = providers[paymentParam as PaymentProviderId];
    return factory?.();
}
