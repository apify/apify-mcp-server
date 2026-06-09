import log from '@apify/log';

import { getApifyAPIBaseUrl } from '../apify_client.js';
import type { ToolEntry } from '../types.js';
import { cloneToolEntry } from '../utils/tools.js';
import { PAYMENT_PROTOCOL_HEADER } from './const.js';
import type { PaymentHeaders, PaymentMeta, PaymentProvider, RequestHeaders } from './types.js';

/**
 * Key used by MCP clients to pass x402 payment data in the JSON-RPC `_meta` field.
 * The mcp-cli injects the decoded payment payload here (JSON object, not base64).
 */
const X402_META_KEY = 'x402/payment';

/** HTTP header name for forwarding x402 payment signatures to the Apify API. */
const PAYMENT_SIGNATURE_HEADER = 'PAYMENT-SIGNATURE';

const PAYMENT_REQUIRED_HEADER = 'payment-required';

/** Timeout for fetching x402 payment requirements from the Apify API (ms). */
const FETCH_TIMEOUT_MS = 8_000;

const X402_TOOL_INSTRUCTIONS = [
    'This tool requires an x402 payment.',
    'Include a valid x402 payment signature in the request metadata (_meta["x402/payment"]).',
    'Your MCP client must support the x402 payment protocol.',
].join(' ');

/**
 * Preferred scheme order when selecting the flat fields exposed on `_meta.x402`.
 *
 * `exact` first to keep the flat-fields contract back-compatible with clients
 * that don't iterate `accepts[]` — they continue to sign `exact` payments as
 * before this PR. Clients that walk `accepts[]` (post-#876 — the current
 * mcpc, the canary) can opt into `upto` via their scheme preference.
 */
const X402_PREFERRED_SCHEMES = ['exact', 'upto'] as const;

/**
 * One entry in a 402 `accepts` array. Mirrors the public x402 v2 wire shape;
 * carried verbatim from the Apify API.
 */
export type X402PaymentAccept = {
    scheme?: string;
    network?: string;
    amount?: string;
    asset?: string;
    payTo?: string;
    maxTimeoutSeconds?: number;
    extra?: Record<string, unknown>;
};

/**
 * Decoded `payment-required` payload returned by the Apify API.
 */
export type X402PaymentRequirements = {
    x402Version?: number;
    resource?: Record<string, unknown>;
    accepts?: X402PaymentAccept[];
};

/**
 * JSON Schema for the x402 `PaymentRequired` object a paid tool returns in
 * `structuredContent` on a 402, per the x402 MCP transport spec
 * (coinbase/x402 `specs/transports-v2/mcp.md` → "Server Requirements").
 * `required: [x402Version, accepts]` are the spec-required fields we use as the branch
 * discriminator. `accepts[]` item internals are left unconstrained — the payload is
 * forwarded verbatim from the trusted Apify API and may carry scheme-specific extras.
 */
export const X402_PAYMENT_REQUIRED_OUTPUT_SCHEMA = {
    type: 'object' as const,
    properties: {
        x402Version: { type: 'number' as const },
        error: { type: 'string' as const },
        resource: { type: 'object' as const },
        accepts: { type: 'array' as const, items: { type: 'object' as const } },
    },
    required: ['x402Version', 'accepts'],
} as const;

/**
 * True if `schema` already carries the x402 PaymentRequired branch — i.e. it was
 * produced by a previous {@link X402PaymentProvider.decorateToolSchema} pass.
 * Keeps re-decoration idempotent (the server may decorate an already-decorated tool).
 */
function hasPaymentRequiredBranch(schema: Record<string, unknown> | undefined): boolean {
    const { anyOf } = schema ?? {};
    if (!Array.isArray(anyOf)) return false;
    // Derive the discriminator from the schema itself so the two can't drift: a drifted
    // guard would miss our own output and silently double-wrap (nested anyOf).
    const discriminator = X402_PAYMENT_REQUIRED_OUTPUT_SCHEMA.required;
    return anyOf.some((branch) => {
        const req = (branch as { required?: unknown })?.required;
        return Array.isArray(req) && discriminator.every((key) => req.includes(key));
    });
}

// Module-level cache for X402 payment requirements.
// We cache the Promise itself (rather than just the JSON result) to prevent the "thundering herd"
// problem during server startup, where multiple concurrent incoming requests might otherwise
// trigger duplicate identical fetches to the Apify API before the first one finishes.
let cachedRequirementsPromise: Promise<X402PaymentRequirements | undefined> | null = null;
let lastFetchTime = 0;
// Cache TTL: 30 minutes
const CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * Fetches x402 payment requirements from the Apify API.
 * Uses a module-level cache with a 30-minute TTL to prevent blocking SSE setup on every connection.
 *
 * Sends a request with `x-apify-payment-protocol: x402` header which triggers
 * a 402 response containing the payment requirements in the `payment-required` header.
 *
 * @returns The decoded payment requirements, or undefined if the fetch fails.
 */
export async function fetchX402PaymentRequirements(): Promise<X402PaymentRequirements | undefined> {
    const now = Date.now();
    // If we have a cached promise, and the TTL hasn't expired since it successfully resolved, return it.
    // Note: During the very first fetch, lastFetchTime is 0, so this will be false and we will
    // fall through to create the promise, which is expected. However, if multiple requests hit this
    // block *while the first fetch is still in-flight*, they will also see lastFetchTime = 0 and
    // create duplicate promises. This is a known minor flaw in this specific caching pattern, but
    // acceptable since the overhead of a few duplicate calls during cold-start is negligible.
    if (cachedRequirementsPromise && now - lastFetchTime < CACHE_TTL_MS) {
        return cachedRequirementsPromise;
    }

    cachedRequirementsPromise = (async () => {
        const apiBaseUrl = getApifyAPIBaseUrl();
        const url = `${apiBaseUrl}/v2/acts/`;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        try {
            const response = await fetch(url, {
                method: 'GET',
                headers: { [PAYMENT_PROTOCOL_HEADER]: 'x402' },
                signal: controller.signal,
            });

            const paymentRequiredBase64 = response.headers.get(PAYMENT_REQUIRED_HEADER);
            if (!paymentRequiredBase64) {
                log.warning('[x402] No payment-required header in API response', { status: response.status, url });
                cachedRequirementsPromise = null;
                return undefined;
            }

            const decoded = JSON.parse(
                Buffer.from(paymentRequiredBase64, 'base64').toString('utf-8'),
            ) as X402PaymentRequirements;
            log.info('[x402] Fetched payment requirements from Apify API', { url });
            lastFetchTime = Date.now();
            return decoded;
        } catch (error) {
            log.warning('[x402] Failed to fetch payment requirements — tools will advertise paymentRequired only', {
                url,
                error,
            });
            cachedRequirementsPromise = null;
            return undefined;
        } finally {
            clearTimeout(timeoutId);
        }
    })();

    return cachedRequirementsPromise;
}

/**
 * Extracts the PAYMENT-SIGNATURE value from incoming HTTP request headers.
 * Header lookup is case-insensitive. Returns the first string value, or undefined.
 */
function getPaymentSignatureFromHeader(requestHeaders?: RequestHeaders): string | undefined {
    if (!requestHeaders) return undefined;

    // HTTP headers are case-insensitive; the SDK may normalize to lowercase
    const value = requestHeaders[PAYMENT_SIGNATURE_HEADER] ?? requestHeaders[PAYMENT_SIGNATURE_HEADER.toLowerCase()];
    if (typeof value === 'string' && value.length > 0) return value;
    if (Array.isArray(value) && typeof value[0] === 'string' && value[0].length > 0) return value[0];
    return undefined;
}

/**
 * Gets the base64-encoded payment signature from either _meta (JSON object) or HTTP headers.
 */
function getEncodedPaymentSignature(meta?: PaymentMeta, requestHeaders?: RequestHeaders): string | undefined {
    const metaPayment = meta?.[X402_META_KEY];
    if (metaPayment) {
        return Buffer.from(JSON.stringify(metaPayment)).toString('base64');
    }

    return getPaymentSignatureFromHeader(requestHeaders);
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

    constructor(private readonly requirements?: X402PaymentRequirements) {}

    /**
     * Creates an X402PaymentProvider, fetching payment requirements from the Apify API.
     * Falls back to a provider without full requirements if the fetch fails.
     */
    static async create(): Promise<X402PaymentProvider> {
        const requirements = await fetchX402PaymentRequirements();
        return new X402PaymentProvider(requirements);
    }

    /**
     * Picks the preferred accept entry for flat `_meta.x402` advertising.
     * Order follows `X402_PREFERRED_SCHEMES`; falls back to the first entry
     * when no preferred scheme matches.
     */
    private selectPreferredAcceptEntry(accepts: X402PaymentAccept[]): X402PaymentAccept {
        for (const preferred of X402_PREFERRED_SCHEMES) {
            const match = accepts.find((entry) => entry.scheme === preferred);
            if (match) return match;
        }
        return accepts[0];
    }

    decorateToolSchema(tool: ToolEntry): ToolEntry {
        if (!tool.paymentRequired) return tool;

        const cloned = cloneToolEntry(tool);

        // Flat preferred fields stay for back-compat with clients that don't iterate `accepts[]`.
        if (!cloned._meta) {
            cloned._meta = {};
        }
        const metaRecord = cloned._meta as Record<string, unknown>;
        if (!metaRecord.x402) {
            const reqs = this.requirements ? structuredClone(this.requirements) : undefined;
            const acceptsRaw = reqs?.accepts;
            const accepts = Array.isArray(acceptsRaw) && acceptsRaw.length > 0 ? acceptsRaw : undefined;
            const preferred = accepts ? this.selectPreferredAcceptEntry(accepts) : undefined;
            metaRecord.x402 = {
                paymentRequired: true,
                ...(preferred ?? {}),
                ...(accepts && { accepts }),
            };
        }

        // Append x402 instructions to description (idempotent)
        if (cloned.description && !cloned.description.includes(X402_TOOL_INSTRUCTIONS)) {
            cloned.description += `\n\n${X402_TOOL_INSTRUCTIONS}`;
        }

        // A paid tool's output is a sum type: its declared success shape OR a 402
        // PaymentRequired object (carried in `structuredContent` per the x402 MCP spec).
        // The MCP SDK *client* validates `structuredContent` against the advertised
        // `outputSchema` even when `isError: true`, so a tool that declares only the
        // success shape makes strict clients (e.g. Cursor) reject the 402 with -32602
        // before the agent sees the payment hint (issue #917). Advertise both shapes via
        // `anyOf` of two disjoint-`required` branches so the spec-mandated PaymentRequired
        // validates while a success payload missing required keys is still rejected.
        // `structuredClone` keeps each tool's schema self-owned — the const is never aliased.
        const outputSchema = cloned.outputSchema as Record<string, unknown> | undefined;
        if (outputSchema && !hasPaymentRequiredBranch(outputSchema)) {
            cloned.outputSchema = {
                type: 'object',
                anyOf: [outputSchema, structuredClone(X402_PAYMENT_REQUIRED_OUTPUT_SCHEMA)],
            } as typeof cloned.outputSchema;
        }

        return Object.freeze(cloned);
    }

    validatePayment(
        _args: Record<string, unknown>,
        meta?: PaymentMeta,
        requestHeaders?: RequestHeaders,
    ): string | null {
        return getEncodedPaymentSignature(meta, requestHeaders) ? null : X402_TOOL_INSTRUCTIONS;
    }

    getPaymentHeaders(
        _args: Record<string, unknown>,
        meta?: PaymentMeta,
        requestHeaders?: RequestHeaders,
    ): PaymentHeaders {
        const paymentSignature = getEncodedPaymentSignature(meta, requestHeaders);
        return paymentSignature
            ? { [PAYMENT_SIGNATURE_HEADER]: paymentSignature, [PAYMENT_PROTOCOL_HEADER]: 'x402' }
            : {};
    }

    removePaymentFields(args: Record<string, unknown>): Record<string, unknown> {
        // x402 doesn't inject anything into tool arguments — payment is in _meta
        return args;
    }

    getPaymentRequiredData(): X402PaymentRequirements | undefined {
        return this.requirements;
    }

    getUsageGuide(): string | null {
        return null;
    }

    redactForLogging(args: unknown): unknown {
        // x402 doesn't put sensitive data in tool arguments
        return args;
    }
}
