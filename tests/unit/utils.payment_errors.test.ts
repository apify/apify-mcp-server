/**
 * Tests for `buildPaymentRequiredResponse` — covers the x402 MCP transport spec
 * requirement that PaymentRequired payloads land in both `structuredContent`
 * (preferred) and `content[0].text` as JSON (fallback). See coinbase/x402
 * `specs/transports-v2/mcp.md`.
 */
import { describe, expect, it } from 'vitest';

import { buildPaymentRequiredResponse, isX402PaymentRequiredError } from '../../src/utils/payment_errors.js';

const SAMPLE_PAYMENT_REQUIRED = {
    x402Version: 2,
    accepts: [
        { scheme: 'exact', network: 'eip155:8453', amount: '100000' },
        { scheme: 'upto', network: 'eip155:8453', amount: '500000' },
    ],
} as const;

describe('isX402PaymentRequiredError()', () => {
    it('returns true for a plain 402, false for the concurrent-run limit arriving as 402', () => {
        expect(isX402PaymentRequiredError(Object.assign(new Error('Payment required'), { statusCode: 402 }))).toBe(
            true,
        );
        const runLimitError = Object.assign(new Error('Cannot start new Actor runs.'), {
            statusCode: 402,
            type: 'cannot-start-actor-runs',
        });
        expect(isX402PaymentRequiredError(runLimitError)).toBe(false);
    });
});

describe('buildPaymentRequiredResponse()', () => {
    it('writes paymentData to both structuredContent and content[0].text', () => {
        const result = buildPaymentRequiredResponse(new Error('Payment required'), SAMPLE_PAYMENT_REQUIRED);

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toEqual(SAMPLE_PAYMENT_REQUIRED);
        expect((result.content ?? [])[0]).toEqual({
            type: 'text',
            text: JSON.stringify(SAMPLE_PAYMENT_REQUIRED),
        });
    });

    it('appends a human-readable text entry after the JSON entry when paymentData is present', () => {
        const result = buildPaymentRequiredResponse(new Error('Payment required'), SAMPLE_PAYMENT_REQUIRED);

        expect(result.content).toHaveLength(2);
        expect((result.content ?? [])[1]).toEqual({
            type: 'text',
            text: 'Payment required to run this Actor or access this resource.',
        });
    });

    it('omits structuredContent and returns only the error message when no paymentData is available', () => {
        const result = buildPaymentRequiredResponse('plain string error');

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toBeUndefined();
        expect(result.content).toEqual([{ type: 'text', text: 'plain string error' }]);
    });
});
