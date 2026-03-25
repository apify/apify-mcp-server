import type { ToolEntry } from '../types.js';
import { cloneToolEntry } from '../utils/tools.js';
import type { PaymentHeaders, PaymentMeta, PaymentProvider, RequestHeaders } from './types.js';

/**
 * Key used by MCP clients to pass x402 payment data in the JSON-RPC `_meta` field.
 * The mcp-cli injects the decoded payment payload here (JSON object, not base64).
 */
const X402_META_KEY = 'x402/payment';

/** HTTP header name for forwarding x402 payment signatures to the Apify API. */
const PAYMENT_SIGNATURE_HEADER = 'PAYMENT-SIGNATURE';
const PAYMENT_PROTOCOL_HEADER = 'x-apify-payment-protocol';

const X402_TOOL_INSTRUCTIONS = [
    'This tool requires an x402 payment.',
    'Include a valid x402 payment signature in the request metadata (_meta["x402/payment"]).',
    'Your MCP client must support the x402 payment protocol.',
].join(' ');

/**
 * Extracts the PAYMENT-SIGNATURE value from incoming HTTP request headers.
 * Header lookup is case-insensitive. Returns the first string value, or undefined.
 */
function getPaymentSignatureFromHeader(requestHeaders: RequestHeaders): string | undefined {
    if (!requestHeaders) return undefined;

    // HTTP headers are case-insensitive; the SDK may normalize to lowercase
    const value = requestHeaders[PAYMENT_SIGNATURE_HEADER] ?? requestHeaders[PAYMENT_SIGNATURE_HEADER.toLowerCase()];
    if (typeof value === 'string' && value.length > 0) return value;
    if (Array.isArray(value) && typeof value[0] === 'string' && value[0].length > 0) return value[0];
    return undefined;
}

/**
 * x402 payment provider.
 *
 * Reads x402 payment signatures from MCP `_meta["x402/payment"]` or the incoming
 * HTTP `PAYMENT-SIGNATURE` header, and forwards them as `PAYMENT-SIGNATURE`
 * headers to the Apify API.
 *
 * Protocol flow:
 * 1. Client reads `_meta.x402` from tool definitions to know payment is required
 * 2. Client signs an EIP-3009 TransferWithAuthorization and includes it in
 *    `_meta["x402/payment"]` (JSON object) and/or the `PAYMENT-SIGNATURE` HTTP header (base64)
 * 3. This provider extracts the payment (preferring `_meta`, falling back to HTTP header),
 *    base64-encodes it if needed, and forwards as PAYMENT-SIGNATURE header
 * 4. The Apify API verifies and settles the payment
 */
export class X402PaymentProvider implements PaymentProvider {
    readonly id = 'x402' as const;
    readonly allowsUnauthenticated = true;

    decorateToolSchema(tool: ToolEntry): ToolEntry {
        if (!tool.paymentRequired) return tool;

        const cloned = cloneToolEntry(tool);

        // Add _meta.x402 to signal payment requirement to clients (idempotent)
        if (!cloned._meta) {
            cloned._meta = {};
        }
        const metaRecord = cloned._meta as Record<string, unknown>;
        if (!metaRecord.x402) {
            metaRecord.x402 = { paymentRequired: true };
        }

        // Append x402 instructions to description (idempotent)
        if (cloned.description && !cloned.description.includes(X402_TOOL_INSTRUCTIONS)) {
            cloned.description += `\n\n${X402_TOOL_INSTRUCTIONS}`;
        }

        return Object.freeze(cloned);
    }

    validatePayment(_args: Record<string, unknown>, meta?: PaymentMeta, requestHeaders?: RequestHeaders): string | null {
        const metaPayment = meta?.[X402_META_KEY];
        if (metaPayment) return null;

        const headerPayment = getPaymentSignatureFromHeader(requestHeaders);
        if (headerPayment) return null;

        return X402_TOOL_INSTRUCTIONS;
    }

    getPaymentHeaders(_args: Record<string, unknown>, meta?: PaymentMeta, requestHeaders?: RequestHeaders): PaymentHeaders {
        // Prefer _meta over HTTP header — _meta is the canonical MCP mechanism
        const metaPayment = meta?.[X402_META_KEY];
        if (metaPayment) {
            // The client sends the payment payload as a JSON object in _meta.
            // The Apify API expects it as a base64-encoded JSON string in the PAYMENT-SIGNATURE header.
            const paymentBase64 = Buffer.from(JSON.stringify(metaPayment)).toString('base64');
            return { [PAYMENT_SIGNATURE_HEADER]: paymentBase64, [PAYMENT_PROTOCOL_HEADER]: 'x402' };
        }

        // Fall back to HTTP PAYMENT-SIGNATURE header (already base64-encoded by the client)
        const headerPayment = getPaymentSignatureFromHeader(requestHeaders);
        if (headerPayment) {
            return { [PAYMENT_SIGNATURE_HEADER]: headerPayment, [PAYMENT_PROTOCOL_HEADER]: 'x402' };
        }

        return {};
    }

    removePaymentFields(args: Record<string, unknown>): Record<string, unknown> {
        // x402 doesn't inject anything into tool arguments — payment is in _meta
        return args;
    }

    getUsageGuide(): string | null {
        return null;
    }

    redactForLogging(args: unknown): unknown {
        // x402 doesn't put sensitive data in tool arguments
        return args;
    }
}
