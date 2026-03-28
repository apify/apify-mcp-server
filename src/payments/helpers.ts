import { ApifyClient } from '../apify_client.js';
import type { ApifyToken, ToolEntry } from '../types.js';
import { buildPaymentRequiredResponse, registerPaymentRequiredInterceptor } from '../utils/payment_errors.js';
import type { PaymentMeta, PaymentProvider, RequestHeaders } from './types.js';

/**
 * Result of preparing payment context for a tool call.
 * Centralizes all payment-related processing into a single step.
 */
export type PreparePaymentResult = {
    /** Structured error result for a 402 PaymentRequired response. Undefined if no error. */
    errorResult?: ReturnType<typeof buildPaymentRequiredResponse>;
    /** Args with payment-specific fields removed — safe for ajv validation and Actor input. */
    cleanArgs: Record<string, unknown>;
    /** Args with sensitive payment fields redacted — safe for logging. */
    logArgs: unknown;
    /** ApifyClient configured with payment headers (if applicable) or standard token. */
    client: ApifyClient;
};

/**
 * Prepares payment context for a tool call.
 *
 * This helper centralizes all payment processing:
 * 1. Validates payment credentials (for tools with `paymentRequired: true`)
 * 2. Strips payment fields from args (for clean ajv validation and Actor input)
 * 3. Redacts sensitive fields for logging
 * 4. Creates an ApifyClient with payment headers or standard token
 *
 * Call this BEFORE ajv validation so `cleanArgs` can be validated without
 * the `additionalProperties: true` hack.
 */
export function preparePayment(input: {
    provider: PaymentProvider | undefined;
    tool: ToolEntry;
    args: Record<string, unknown>;
    apifyToken: ApifyToken;
    meta?: PaymentMeta;
    requestHeaders?: RequestHeaders;
}): PreparePaymentResult {
    const { provider, tool, args, apifyToken, meta, requestHeaders } = input;

    if (!provider) {
        const client = new ApifyClient({ token: apifyToken });
        registerPaymentRequiredInterceptor(client);
        return {
            cleanArgs: args,
            logArgs: args,
            client,
        };
    }

    const error = tool.paymentRequired ? provider.validatePayment(args, meta, requestHeaders) : null;
    const errorData = error && provider.getPaymentRequiredData ? provider.getPaymentRequiredData() : undefined;
    const cleanArgs = provider.removePaymentFields(args);
    const logArgs = provider.redactForLogging(args);

    const paymentHeaders = provider.getPaymentHeaders(args, meta, requestHeaders);
    const client = Object.keys(paymentHeaders).length > 0
        ? new ApifyClient({ paymentHeaders })
        : new ApifyClient({ token: apifyToken });
    registerPaymentRequiredInterceptor(client);

    return {
        errorResult: error ? buildPaymentRequiredResponse(error, errorData) : undefined,
        cleanArgs,
        logArgs,
        client,
    };
}
