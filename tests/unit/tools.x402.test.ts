/**
 * Tests for X402PaymentProvider — focused on the dual-channel payment extraction
 * (_meta["x402/payment"] JSON object vs HTTP PAYMENT-SIGNATURE header fallback).
 */
import { beforeEach, describe, expect, it } from 'vitest';

import type { PaymentMeta, RequestHeaders } from '../../src/payments/types.js';
import { X402PaymentProvider } from '../../src/payments/x402.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_PAYMENT = { x402Version: 2, payload: { signature: 'test-sig' } };
const SAMPLE_PAYMENT_BASE64 = Buffer.from(JSON.stringify(SAMPLE_PAYMENT)).toString('base64');

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
        const headerBase64 = Buffer.from(JSON.stringify({ x402Version: 2, payload: { signature: 'from-header' } })).toString('base64');

        const meta: PaymentMeta = { 'x402/payment': metaPayment };
        const headers: RequestHeaders = { 'PAYMENT-SIGNATURE': headerBase64 };
        const result = provider.getPaymentHeaders({}, meta, headers);

        expect(result).toEqual({ 'PAYMENT-SIGNATURE': metaBase64, 'x-apify-payment-protocol': 'x402' });
    });
});
