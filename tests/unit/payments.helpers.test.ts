/**
 * Tests for prepareToolCallContext — the function that strips payment fields
 * before AJV validation and creates the ApifyClient.
 *
 * Key invariants under test:
 * 1. Payment fields are stripped before AJV ever sees the args
 * 2. toolArgsWithoutPayment and toolArgsRedacted are separate object references
 *    (so AJV's in-place removeAdditional mutation doesn't corrupt toolArgsRedacted)
 * 3. Missing payment fails with paymentRequiredResult, not a validation error
 * 4. No-provider path also returns separate references
 */
import { describe, expect, it, vi } from 'vitest';

import { prepareToolCallContext } from '../../src/payments/helpers.js';
import type { PaymentProvider } from '../../src/payments/types.js';
import type { HelperTool } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_APIFY_TOKEN = 'apify_api_test_token' as const;

function makeTool(paymentRequired = true): HelperTool {
    return {
        name: 'call-actor',
        description: 'Call an Actor',
        type: 'internal',
        paymentRequired,
        inputSchema: { type: 'object', properties: { actor: { type: 'string' } } },
        ajvValidate: vi.fn(() => true) as never,
        call: vi.fn(async () => ({ content: [] })),
    };
}

/**
 * A mock payment provider that mimics Skyfire: injects a `skyfire-pay-id`
 * field into tool args, then strips it in removePaymentFields.
 */
function makeSkyfireLikeProvider(): PaymentProvider {
    return {
        id: 'skyfire',
        allowsUnauthenticated: true,
        decorateToolSchema: (tool) => tool,
        validatePayment: (args) => (args['skyfire-pay-id'] ? null : 'Missing skyfire-pay-id'),
        getPaymentHeaders: (args): Record<string, string> => (args['skyfire-pay-id'] ? { 'skyfire-pay-id': args['skyfire-pay-id'] as string } : {}),
        removePaymentFields: (args) => {
            const { 'skyfire-pay-id': _removed, ...rest } = args;
            return rest;
        },
        redactForLogging: (args) => {
            const a = args as Record<string, unknown>;
            return { ...a, 'skyfire-pay-id': '[REDACTED]' };
        },
    };
}

// ---------------------------------------------------------------------------
// Tests: no payment provider
// ---------------------------------------------------------------------------

describe('prepareToolCallContext — no provider', () => {
    it('returns toolArgs and logSafeArgs as separate references', () => {
        const args = { actor: 'apify/rag-web-browser', extra: 'noise' };
        const result = prepareToolCallContext({
            provider: undefined,
            tool: makeTool(false),
            args,
            apifyToken: MOCK_APIFY_TOKEN,
        });

        // logSafeArgs is the original object
        expect(result.toolArgsRedacted).toBe(args);
        // toolArgs is a shallow copy — different reference
        expect(result.toolArgsWithoutPayment).not.toBe(args);
        expect(result.toolArgsWithoutPayment).toEqual(args);
    });

    it('AJV mutation of toolArgs does not affect logSafeArgs', () => {
        const args = { actor: 'apify/rag-web-browser', unknownExtra: 'should-be-stripped' };
        const result = prepareToolCallContext({
            provider: undefined,
            tool: makeTool(false),
            args,
            apifyToken: MOCK_APIFY_TOKEN,
        });

        // Simulate what AJV removeAdditional does: mutates toolArgs in place
        delete (result.toolArgsWithoutPayment as Record<string, unknown>).unknownExtra;

        // logSafeArgs (original args) is untouched — still has the extra key
        expect((result.toolArgsRedacted as Record<string, unknown>).unknownExtra).toBe('should-be-stripped');
    });

    it('returns no paymentRequiredResult', () => {
        const result = prepareToolCallContext({
            provider: undefined,
            tool: makeTool(false),
            args: { actor: 'apify/rag-web-browser' },
            apifyToken: MOCK_APIFY_TOKEN,
        });
        expect(result.paymentRequiredResult).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// Tests: Skyfire-like provider
// ---------------------------------------------------------------------------

describe('prepareToolCallContext — Skyfire-like provider', () => {
    it('strips payment field from toolArgs before validation', () => {
        const args = { actor: 'apify/rag-web-browser', 'skyfire-pay-id': 'jwt-token-123' };
        const result = prepareToolCallContext({
            provider: makeSkyfireLikeProvider(),
            tool: makeTool(true),
            args,
            apifyToken: MOCK_APIFY_TOKEN,
        });

        // Payment field removed from toolArgs — AJV will never see it
        expect(result.toolArgsWithoutPayment).not.toHaveProperty('skyfire-pay-id');
        expect(result.toolArgsWithoutPayment).toEqual({ actor: 'apify/rag-web-browser' });
    });

    it('toolArgs and logSafeArgs are separate references', () => {
        const args = { actor: 'apify/rag-web-browser', 'skyfire-pay-id': 'jwt-token-123' };
        const result = prepareToolCallContext({
            provider: makeSkyfireLikeProvider(),
            tool: makeTool(true),
            args,
            apifyToken: MOCK_APIFY_TOKEN,
        });

        expect(result.toolArgsWithoutPayment).not.toBe(result.toolArgsRedacted);
    });

    it('redacts payment field in logSafeArgs', () => {
        const args = { actor: 'apify/rag-web-browser', 'skyfire-pay-id': 'jwt-token-123' };
        const result = prepareToolCallContext({
            provider: makeSkyfireLikeProvider(),
            tool: makeTool(true),
            args,
            apifyToken: MOCK_APIFY_TOKEN,
        });

        expect((result.toolArgsRedacted as Record<string, unknown>)['skyfire-pay-id']).toBe('[REDACTED]');
    });

    it('returns paymentRequiredResult when payment field is missing', () => {
        const args = { actor: 'apify/rag-web-browser' }; // no skyfire-pay-id
        const result = prepareToolCallContext({
            provider: makeSkyfireLikeProvider(),
            tool: makeTool(true),
            args,
            apifyToken: MOCK_APIFY_TOKEN,
        });

        expect(result.paymentRequiredResult).toBeDefined();
        // Still no error from AJV — validation hasn't run yet at this point
    });

    it('no paymentRequiredResult when payment is valid', () => {
        const args = { actor: 'apify/rag-web-browser', 'skyfire-pay-id': 'valid-jwt' };
        const result = prepareToolCallContext({
            provider: makeSkyfireLikeProvider(),
            tool: makeTool(true),
            args,
            apifyToken: MOCK_APIFY_TOKEN,
        });

        expect(result.paymentRequiredResult).toBeUndefined();
    });

    it('skips payment validation for tools without paymentRequired', () => {
        // Tool does not require payment — even without skyfire-pay-id, no error
        const args = { actor: 'apify/rag-web-browser' };
        const result = prepareToolCallContext({
            provider: makeSkyfireLikeProvider(),
            tool: makeTool(false), // paymentRequired = false
            args,
            apifyToken: MOCK_APIFY_TOKEN,
        });

        expect(result.paymentRequiredResult).toBeUndefined();
    });
});
