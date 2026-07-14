/**
 * Tests for X402PaymentProvider — payment extraction (_meta["x402/payment"] vs
 * HTTP PAYMENT-SIGNATURE header) and tool-schema decoration with multi-scheme `accepts[]`.
 */
import Ajv from 'ajv';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PaymentMeta, RequestHeaders } from '../../src/payments/types.js';
import {
    X402_PAYMENT_REQUIRED_OUTPUT_SCHEMA,
    X402PaymentProvider,
    type X402PaymentRequirements,
} from '../../src/payments/x402.js';
import { actorRunOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { HelperTool } from '../../src/types.js';
import { TOOL_TYPE } from '../../src/types.js';
import { respondRaw } from '../../src/utils/mcp.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_PAYMENT = { x402Version: 2, payload: { signature: 'test-sig' } };
const SAMPLE_PAYMENT_BASE64 = Buffer.from(JSON.stringify(SAMPLE_PAYMENT)).toString('base64');

const EXACT_ACCEPT = {
    scheme: 'exact',
    network: 'eip155:8453',
    amount: '100000',
    asset: '0xExact',
    payTo: '0xPayee',
    maxTimeoutSeconds: 60,
    extra: { name: 'USDC', version: '2' },
} as const;

const UPTO_ACCEPT = {
    scheme: 'upto',
    network: 'eip155:8453',
    amount: '500000',
    asset: '0xUpto',
    payTo: '0xPayee',
    maxTimeoutSeconds: 18_000,
    extra: { name: 'USDC', version: '2', facilitatorAddress: '0xFac' },
} as const;

/** A successful Actor run result — satisfies the `actorRunOutputSchema` branch. */
const SAMPLE_RUN_RESPONSE = {
    runId: 'abc123',
    actorId: 'JxcaGGqy7TwBdHxMz',
    actorName: 'janedoe/my-actor',
    status: 'SUCCEEDED',
    storages: { datasets: { default: { id: 'ds1' } } },
    summary: 'Run finished.',
    nextStep: 'Call get-dataset-items with datasetId ds1.',
};

/** A 402 PaymentRequired payload — satisfies the x402 branch. */
const SAMPLE_PAYMENT_REQUIRED = {
    x402Version: 2,
    error: 'Payment required',
    resource: { url: 'mcp://tool/paid-tool' },
    accepts: [EXACT_ACCEPT],
};

function makePaidTool(overrides: Partial<HelperTool> = {}): HelperTool {
    return {
        name: 'paid-tool',
        description: 'Paid tool',
        type: TOOL_TYPE.INTERNAL,
        paymentRequired: true,
        inputSchema: { type: 'object' as const, properties: {} },
        ajvValidate: vi.fn(() => true) as never,
        call: vi.fn(async () => respondRaw({ content: [] })),
        ...overrides,
    };
}

function getX402Meta(tool: { _meta?: unknown }): Record<string, unknown> | undefined {
    const meta = tool._meta as { x402?: Record<string, unknown> } | undefined;
    return meta?.x402;
}

let provider: X402PaymentProvider;

beforeEach(() => {
    provider = new X402PaymentProvider();
});

// ---------------------------------------------------------------------------
// validatePayment
// ---------------------------------------------------------------------------

describe('validatePayment', () => {
    it('should return error when neither _meta nor HTTP header is present', () => {
        const result = provider.validatePayment({}, undefined, undefined);
        expect(result).toBeTypeOf('string');
        expect(result).toContain('x402');
    });

    it('should accept payment from lowercase HTTP header (case-insensitive, no _meta)', () => {
        // The SDK may normalize headers to lowercase depending on transport
        const headers: RequestHeaders = { 'payment-signature': SAMPLE_PAYMENT_BASE64 };
        const result = provider.validatePayment({}, undefined, headers);
        expect(result).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// getPaymentHeaders
// ---------------------------------------------------------------------------

describe('getPaymentHeaders', () => {
    it('should base64-encode _meta["x402/payment"] JSON for the outbound PAYMENT-SIGNATURE header', () => {
        const meta: PaymentMeta = { 'x402/payment': SAMPLE_PAYMENT };
        const result = provider.getPaymentHeaders({}, meta, undefined);

        expect(result).toEqual({ 'PAYMENT-SIGNATURE': SAMPLE_PAYMENT_BASE64, 'x-apify-payment-protocol': 'x402' });
    });

    it('should forward the HTTP PAYMENT-SIGNATURE header directly (already base64)', () => {
        const headers: RequestHeaders = { 'PAYMENT-SIGNATURE': SAMPLE_PAYMENT_BASE64 };
        const result = provider.getPaymentHeaders({}, undefined, headers);

        expect(result).toEqual({ 'PAYMENT-SIGNATURE': SAMPLE_PAYMENT_BASE64, 'x-apify-payment-protocol': 'x402' });
    });

    it('should prefer _meta over HTTP header when both are present', () => {
        const metaPayment = { x402Version: 2, payload: { signature: 'from-meta' } };
        const metaBase64 = Buffer.from(JSON.stringify(metaPayment)).toString('base64');
        const headerBase64 = Buffer.from(
            JSON.stringify({ x402Version: 2, payload: { signature: 'from-header' } }),
        ).toString('base64');

        const meta: PaymentMeta = { 'x402/payment': metaPayment };
        const headers: RequestHeaders = { 'PAYMENT-SIGNATURE': headerBase64 };
        const result = provider.getPaymentHeaders({}, meta, headers);

        expect(result).toEqual({ 'PAYMENT-SIGNATURE': metaBase64, 'x-apify-payment-protocol': 'x402' });
    });
});

// ---------------------------------------------------------------------------
// decorateToolSchema
// ---------------------------------------------------------------------------

describe('decorateToolSchema()', () => {
    it('returns the original tool unchanged when paymentRequired is not set', () => {
        const requirements: X402PaymentRequirements = { x402Version: 2, accepts: [EXACT_ACCEPT] };
        const freeTool = makePaidTool({ paymentRequired: false });
        const decorated = new X402PaymentProvider(requirements).decorateToolSchema(freeTool);

        expect(decorated).toBe(freeTool);
        expect(decorated._meta).toBeUndefined();
    });

    it('selects the exact entry over upto for flat fields and exposes both in accepts[]', () => {
        // Back-compat: clients that read only flat fields keep signing `exact` like before #876.
        const requirements: X402PaymentRequirements = { x402Version: 2, accepts: [EXACT_ACCEPT, UPTO_ACCEPT] };
        const decorated = new X402PaymentProvider(requirements).decorateToolSchema(makePaidTool());

        const x402 = getX402Meta(decorated);
        expect(x402?.paymentRequired).toBe(true);
        expect(x402?.scheme).toBe('exact');
        expect(x402?.amount).toBe(EXACT_ACCEPT.amount);
        expect(x402?.accepts).toEqual([EXACT_ACCEPT, UPTO_ACCEPT]);
    });

    it('falls back to upto when exact is not present', () => {
        const requirements: X402PaymentRequirements = { x402Version: 2, accepts: [UPTO_ACCEPT] };
        const decorated = new X402PaymentProvider(requirements).decorateToolSchema(makePaidTool());

        const x402 = getX402Meta(decorated);
        expect(x402?.scheme).toBe('upto');
        expect(x402?.accepts).toEqual([UPTO_ACCEPT]);
    });

    it('falls back to the first entry when neither exact nor upto is present', () => {
        const customAccept = { ...EXACT_ACCEPT, scheme: 'custom-scheme' };
        const requirements: X402PaymentRequirements = { x402Version: 2, accepts: [customAccept] };
        const decorated = new X402PaymentProvider(requirements).decorateToolSchema(makePaidTool());

        const x402 = getX402Meta(decorated);
        expect(x402?.scheme).toBe('custom-scheme');
        expect(x402?.accepts).toEqual([customAccept]);
    });

    it('preserves the configured order in accepts[] regardless of preference selection', () => {
        // Server-emitted order may be non-deterministic upstream; whatever we receive is
        // what we forward. Preference only drives the flat-field selection.
        const requirements: X402PaymentRequirements = { x402Version: 2, accepts: [UPTO_ACCEPT, EXACT_ACCEPT] };
        const decorated = new X402PaymentProvider(requirements).decorateToolSchema(makePaidTool());

        const x402 = getX402Meta(decorated);
        expect(x402?.accepts).toEqual([UPTO_ACCEPT, EXACT_ACCEPT]);
        expect(x402?.scheme).toBe('exact');
    });

    it('marks paymentRequired without flat fields or accepts[] when requirements were not fetched', () => {
        const decorated = new X402PaymentProvider(undefined).decorateToolSchema(makePaidTool());

        const x402 = getX402Meta(decorated);
        expect(x402).toEqual({ paymentRequired: true });
    });

    it('marks paymentRequired without flat fields or accepts[] when accepts is empty', () => {
        const requirements: X402PaymentRequirements = { x402Version: 2, accepts: [] };
        const decorated = new X402PaymentProvider(requirements).decorateToolSchema(makePaidTool());

        const x402 = getX402Meta(decorated);
        expect(x402).toEqual({ paymentRequired: true });
    });

    it('appends x402 tool instructions to the description', () => {
        const requirements: X402PaymentRequirements = { x402Version: 2, accepts: [EXACT_ACCEPT] };
        const decorated = new X402PaymentProvider(requirements).decorateToolSchema(makePaidTool());

        expect(decorated.description).toContain('x402 payment');
    });

    it('is idempotent — second decoration does not change _meta.x402 or duplicate instructions', () => {
        const requirements: X402PaymentRequirements = { x402Version: 2, accepts: [EXACT_ACCEPT, UPTO_ACCEPT] };
        const x402Provider = new X402PaymentProvider(requirements);
        const once = x402Provider.decorateToolSchema(makePaidTool());
        const twice = x402Provider.decorateToolSchema(once);

        expect(getX402Meta(twice)).toEqual(getX402Meta(once));
        const instructionsCount = (twice.description ?? '').match(/This tool requires an x402 payment/g)?.length ?? 0;
        expect(instructionsCount).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// outputSchema widening (issue #917)
// ---------------------------------------------------------------------------

describe('decorateToolSchema() — outputSchema widening (#917)', () => {
    const requirements: X402PaymentRequirements = { x402Version: 2, accepts: [EXACT_ACCEPT] };

    function decorateWithSchema(outputSchema: unknown) {
        return new X402PaymentProvider(requirements).decorateToolSchema(
            makePaidTool({ outputSchema } as unknown as Partial<HelperTool>),
        );
    }

    it('wraps an existing outputSchema in anyOf:[success, PaymentRequired] with root type:object', () => {
        const schema = decorateWithSchema(actorRunOutputSchema).outputSchema as {
            type: string;
            anyOf: unknown[];
        };
        // MCP requires root type:'object'; the SDK Tool.outputSchema zod keeps `anyOf` via .catchall().
        expect(schema.type).toBe('object');
        expect(schema.anyOf).toHaveLength(2);
        expect(schema.anyOf[0]).toEqual(actorRunOutputSchema);
        expect(schema.anyOf[1]).toEqual(X402_PAYMENT_REQUIRED_OUTPUT_SCHEMA);
    });

    it('does not invent an outputSchema for a paid tool that declares none', () => {
        const decorated = new X402PaymentProvider(requirements).decorateToolSchema(makePaidTool());
        expect(decorated.outputSchema).toBeUndefined();
    });

    it('is idempotent — re-decorating an already-widened tool does not nest anyOf', () => {
        const provider2 = new X402PaymentProvider(requirements);
        const once = provider2.decorateToolSchema(
            makePaidTool({ outputSchema: actorRunOutputSchema } as unknown as Partial<HelperTool>),
        );
        const twice = provider2.decorateToolSchema(once);

        const { anyOf } = twice.outputSchema as unknown as { anyOf: unknown[] };
        expect(anyOf).toHaveLength(2);
        // If the guard regressed and re-wrapped, anyOf[0] would be the nested
        // { type, anyOf:[...] } wrapper rather than the original success schema.
        expect(anyOf[0]).toEqual(actorRunOutputSchema);
    });

    it('widened schema validates a successful run AND a PaymentRequired, and rejects garbage', () => {
        const widened = decorateWithSchema(actorRunOutputSchema).outputSchema as object;
        // new Ajv({ strict:false }) matches the MCP SDK client validator here: the SDK also
        // adds ajv-formats, but neither branch uses a `format` keyword, so results are identical.
        const validate = new Ajv({ strict: false, allErrors: true }).compile(widened);

        expect(validate(SAMPLE_RUN_RESPONSE)).toBe(true); // normal output keeps working
        expect(validate(SAMPLE_PAYMENT_REQUIRED)).toBe(true); // 402 payload now validates
        expect(validate({})).toBe(false); // disjoint required-sets still reject garbage
        // anyOf did NOT loosen success validation: a run missing required keys still fails.
        expect(validate({ status: 'SUCCEEDED' })).toBe(false);
    });
});
