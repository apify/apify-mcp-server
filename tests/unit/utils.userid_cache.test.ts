import { describe, expect, it, vi } from 'vitest';

import type { ApifyClient } from '../../src/apify_client.js';
import { getUserInfoCached } from '../../src/utils/userid_cache.js';

function stubClient(getImpl: () => Promise<unknown>): ApifyClient {
    return {
        user: vi.fn(() => ({ get: getImpl })),
    } as unknown as ApifyClient;
}

describe('getUserInfoCached', () => {
    it('returns userId and userPlanTier read from plan.tier', async () => {
        const client = stubClient(async () => ({ id: 'u1', plan: { id: 'BUSINESS', tier: 'GOLD' } }));
        const out = await getUserInfoCached(`token-${Math.random()}`, client);
        expect(out.userId).toBe('u1');
        expect(out.userPlanTier).toBe('GOLD');
    });

    it.each([
        ['FREE', 'FREE'],
        ['BRONZE', 'BRONZE'],
        ['SILVER', 'SILVER'],
        ['GOLD', 'GOLD'],
        ['PLATINUM', 'PLATINUM'],
        ['DIAMOND', 'DIAMOND'],
    ])('maps plan.tier %s to %s', async (input, expected) => {
        const client = stubClient(async () => ({ id: 'u', plan: { id: 'ANY_PLAN_ID', tier: input } }));
        const out = await getUserInfoCached(`token-${Math.random()}`, client);
        expect(out.userPlanTier).toBe(expected);
    });

    it('normalizes lowercase tier to uppercase', async () => {
        const client = stubClient(async () => ({ id: 'u2', plan: { tier: 'silver' } }));
        const out = await getUserInfoCached(`token-${Math.random()}`, client);
        expect(out.userPlanTier).toBe('SILVER');
    });

    it('ignores plan.id when deriving the tier (bug fix: plan.id is not the tier)', async () => {
        // plan.id values like STARTER/SCALE/BUSINESS don't match PricingTier names;
        // only plan.tier should drive the tier choice.
        const client = stubClient(async () => ({ id: 'u', plan: { id: 'STARTER', tier: 'BRONZE' } }));
        const out = await getUserInfoCached(`token-${Math.random()}`, client);
        expect(out.userPlanTier).toBe('BRONZE');
    });

    it('defaults to FREE when plan is missing', async () => {
        const client = stubClient(async () => ({ id: 'u3' }));
        const out = await getUserInfoCached(`token-${Math.random()}`, client);
        expect(out.userId).toBe('u3');
        expect(out.userPlanTier).toBe('FREE');
    });

    it('defaults to FREE when plan.tier is missing', async () => {
        const client = stubClient(async () => ({ id: 'u', plan: { id: 'BUSINESS' } }));
        const out = await getUserInfoCached(`token-${Math.random()}`, client);
        expect(out.userPlanTier).toBe('FREE');
    });

    it('defaults to FREE when plan.tier is unrecognized', async () => {
        const client = stubClient(async () => ({ id: 'u4', plan: { tier: 'UNOBTANIUM' } }));
        const out = await getUserInfoCached(`token-${Math.random()}`, client);
        expect(out.userPlanTier).toBe('FREE');
    });

    it('returns FREE and null userId when API call fails', async () => {
        const client = stubClient(async () => { throw new Error('network'); });
        const out = await getUserInfoCached(`token-${Math.random()}`, client);
        expect(out).toEqual({ userId: null, userPlanTier: 'FREE' });
    });

    it('caches result and avoids second API call', async () => {
        const get = vi.fn(async () => ({ id: 'u5', plan: { tier: 'PLATINUM' } }));
        const client = { user: vi.fn(() => ({ get })) } as unknown as ApifyClient;
        const token = `token-${Math.random()}`;
        await getUserInfoCached(token, client);
        await getUserInfoCached(token, client);
        expect(get).toHaveBeenCalledTimes(1);
    });

    it.each([undefined, ''])('returns anonymous FREE default without calling API when token is %p', async (token) => {
        const get = vi.fn();
        const client = { user: vi.fn(() => ({ get })) } as unknown as ApifyClient;
        const out = await getUserInfoCached(token, client);
        expect(out).toEqual({ userId: null, userPlanTier: 'FREE' });
        expect(get).not.toHaveBeenCalled();
    });

    it('does NOT cache failed lookups (next call retries)', async () => {
        let attempts = 0;
        const get = vi.fn(async () => {
            attempts += 1;
            if (attempts === 1) throw new Error('transient');
            return { id: 'u6', plan: { tier: 'BRONZE' } };
        });
        const client = { user: vi.fn(() => ({ get })) } as unknown as ApifyClient;
        const token = `token-${Math.random()}`;
        const first = await getUserInfoCached(token, client);
        expect(first).toEqual({ userId: null, userPlanTier: 'FREE' });
        const second = await getUserInfoCached(token, client);
        expect(second).toEqual({ userId: 'u6', userPlanTier: 'BRONZE' });
        expect(get).toHaveBeenCalledTimes(2);
    });
});
