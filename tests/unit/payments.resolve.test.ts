import { describe, expect, it } from 'vitest';

import { resolvePaymentProvider } from '../../src/payments/resolve.js';

describe('payment provider lookup from the ?payment= value', () => {
    it('returns the provider for a known id', async () => {
        const provider = await resolvePaymentProvider('skyfire');

        expect(provider?.id).toBe('skyfire');
    });

    it('returns undefined for an Object.prototype member name', async () => {
        // `constructor` resolved through the prototype chain to a truthy `{}`, which the HTTP auth
        // gate accepted as a payment provider and skipped token validation.
        await expect(resolvePaymentProvider('constructor')).resolves.toBeUndefined();
        await expect(resolvePaymentProvider('toString')).resolves.toBeUndefined();
    });
});
