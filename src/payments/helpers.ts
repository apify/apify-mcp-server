import { ApifyClient } from '../apify_client.js';
import type { ApifyToken, ToolEntry } from '../types.js';
import { buildPaymentRequiredResponse, registerPaymentRequiredInterceptor } from '../utils/payment_errors.js';
import type { PaymentMeta, PaymentProvider, RequestHeaders } from './types.js';

/**
 * Result of preparing tool-call context.
 * Centralizes payment-aware argument sanitization, logging data, and client creation.
 */
export type PrepareToolCallContextResult = {
    /** Structured error result for a 402 PaymentRequired response. Undefined if no error. */
    paymentRequiredResult?: ReturnType<typeof buildPaymentRequiredResponse>;
    /** Tool args with payment-specific fields removed — safe for ajv validation and Actor input. */
    toolArgs: Record<string, unknown>;
    /** Tool args with sensitive payment fields redacted — safe for logging. */
    logSafeArgs: unknown;
    /** ApifyClient configured with payment headers (if applicable) or standard token. */
    apifyClient: ApifyClient;
};

/**
 * Prepares tool-call context before validation and execution.
 *
 * This helper centralizes all payment processing:
 * 1. Validates payment credentials (for tools with `paymentRequired: true`)
 * 2. Strips payment fields from args (for clean ajv validation and Actor input)
 * 3. Redacts sensitive fields for logging
 * 4. Creates an ApifyClient with payment headers or standard token
 *
 * Call this BEFORE ajv validation so `toolArgs` can be validated without
 * the `additionalProperties: true` hack.
 *
 * TODO: This function has mixed responsibilities. It should be split into separate concerns:
 * - validatePaymentCredentials (returns error or void)
 * - sanitizeToolArgs (returns toolArgs and logSafeArgs)
 * - createApifyClient (returns apifyClient)
 */
export function prepareToolCallContext(input: {
    provider: PaymentProvider | undefined;
    tool: ToolEntry;
    args: Record<string, unknown>;
    apifyToken: ApifyToken;
    meta?: PaymentMeta;
    requestHeaders?: RequestHeaders;
}): PrepareToolCallContextResult {
    const { provider, tool, args, apifyToken, meta, requestHeaders } = input;

    if (!provider) {
        const apifyClient = new ApifyClient({ token: apifyToken });
        registerPaymentRequiredInterceptor(apifyClient);
        return {
            toolArgs: args,
            logSafeArgs: args,
            apifyClient,
        };
    }

    const error = tool.paymentRequired ? provider.validatePayment(args, meta, requestHeaders) : null;
    const errorData = error && provider.getPaymentRequiredData ? provider.getPaymentRequiredData() : undefined;
    const toolArgs = provider.removePaymentFields(args);
    const logSafeArgs = provider.redactForLogging(args);

    const paymentHeaders = provider.getPaymentHeaders(args, meta, requestHeaders);
    const apifyClient = Object.keys(paymentHeaders).length > 0
        ? new ApifyClient({ paymentHeaders })
        : new ApifyClient({ token: apifyToken });
    registerPaymentRequiredInterceptor(apifyClient);

    return {
        paymentRequiredResult: error ? buildPaymentRequiredResponse(error, errorData) : undefined,
        toolArgs,
        logSafeArgs,
        apifyClient,
    };
}
