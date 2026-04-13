import { describe, expect, it, vi } from 'vitest';

import type { ApifyClient } from '../../src/apify_client.js';
import { getUserInfoCached } from '../../src/utils/userid_cache.js';

function stubClient(getImpl: () => Promise<unknown>): ApifyClient {
    return {
        user: vi.fn(() => ({ get: getImpl })),
    } as unknown as ApifyClient;
}

describe('getUserInfoCached', () => {
    it('returns userId and userPlanTier from API', async () => {
        const client = stubClient(async () => ({ id: 'u1', plan: { id: 'GOLD' } }));
        const out = await getUserInfoCached(`token-${Math.random()}`, client);
        expect(out.userId).toBe('u1');
        expect(out.userPlanTier).toBe('GOLD');
    });

    it('normalizes lowercase plan id to uppercase tier', async () => {
        const client = stubClient(async () => ({ id: 'u2', plan: { id: 'silver' } }));
        const out = await getUserInfoCached(`token-${Math.random()}`, client);
        expect(out.userPlanTier).toBe('SILVER');
    });

    it('defaults to FREE when plan is missing', async () => {
        const client = stubClient(async () => ({ id: 'u3' }));
        const out = await getUserInfoCached(`token-${Math.random()}`, client);
        expect(out.userId).toBe('u3');
        expect(out.userPlanTier).toBe('FREE');
    });

    it('defaults to FREE when plan id is unrecognized', async () => {
        const client = stubClient(async () => ({ id: 'u4', plan: { id: 'CUSTOM_ENTERPRISE' } }));
        const out = await getUserInfoCached(`token-${Math.random()}`, client);
        expect(out.userPlanTier).toBe('FREE');
    });

    it('returns FREE and null userId when API call fails', async () => {
        const client = stubClient(async () => { throw new Error('network'); });
        const out = await getUserInfoCached(`token-${Math.random()}`, client);
        expect(out).toEqual({ userId: null, userPlanTier: 'FREE' });
    });

    it('caches result and avoids second API call', async () => {
        const get = vi.fn(async () => ({ id: 'u5', plan: { id: 'PLATINUM' } }));
        const client = { user: vi.fn(() => ({ get })) } as unknown as ApifyClient;
        const token = `token-${Math.random()}`;
        await getUserInfoCached(token, client);
        await getUserInfoCached(token, client);
        expect(get).toHaveBeenCalledTimes(1);
    });

    it('does NOT cache failed lookups (next call retries)', async () => {
        let attempts = 0;
        const get = vi.fn(async () => {
            attempts += 1;
            if (attempts === 1) throw new Error('transient');
            return { id: 'u6', plan: { id: 'BRONZE' } };
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
