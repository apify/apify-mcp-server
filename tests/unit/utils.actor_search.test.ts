import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApifyClient } from '../../src/apify_client.js';
import type { ActorStoreList } from '../../src/types.js';
import { searchActorsByKeywords, searchAgentSafeActors } from '../../src/utils/actor_search.js';

const listMock = vi.fn();
const paramsHolder: { params: Record<string, unknown> } = { params: {} };

const stubApifyClient = {
    store: () => ({
        get params(): Record<string, unknown> {
            return paramsHolder.params;
        },
        set params(value: Record<string, unknown>) {
            paramsHolder.params = value;
        },
        list: listMock,
    }),
} as unknown as ApifyClient;

const baseStoreActor: ActorStoreList = {
    id: 'id-default',
    name: 'actor-default',
    username: 'user',
    url: 'https://apify.com/user/actor-default',
    currentPricingInfo: {
        pricingModel: 'FREE',
        apifyMarginPercentage: 0,
        createdAt: new Date(0),
        startedAt: new Date(0),
    },
    stats: {
        totalBuilds: 0,
        totalRuns: 0,
        totalUsers: 0,
        totalUsers7Days: 0,
        totalUsers30Days: 0,
        totalUsers90Days: 0,
        totalMetamorphs: 0,
        lastRunStartedAt: new Date(0),
    },
};

function makeActor(overrides: Partial<ActorStoreList> = {}): ActorStoreList {
    return { ...baseStoreActor, ...overrides };
}

describe('searchActorsByKeywords', () => {
    beforeEach(() => {
        listMock.mockReset();
        paramsHolder.params = {};
    });

    it('forwards `includeInputSchema` and `allowsAgenticUsers` as store-client params', async () => {
        listMock.mockResolvedValueOnce({ items: [] });
        await searchActorsByKeywords({
            search: 'foo',
            apifyClient: stubApifyClient,
            limit: 5,
            offset: 0,
            includeInputSchema: true,
            allowsAgenticUsers: true,
        });
        expect(paramsHolder.params).toMatchObject({ includeInputSchema: true, allowsAgenticUsers: true });
        expect(listMock).toHaveBeenCalledWith({ search: 'foo', limit: 5, offset: 0 });
    });

    it('omits both flags when not provided', async () => {
        listMock.mockResolvedValueOnce({ items: [] });
        await searchActorsByKeywords({ search: 'foo', apifyClient: stubApifyClient, limit: 5 });
        expect(paramsHolder.params).not.toHaveProperty('includeInputSchema');
        expect(paramsHolder.params).not.toHaveProperty('allowsAgenticUsers');
    });
});

describe('searchAgentSafeActors', () => {
    beforeEach(() => {
        listMock.mockReset();
        paramsHolder.params = {};
    });

    it('always sets includeInputSchema=true (public limit is capped at the API max)', async () => {
        listMock.mockResolvedValueOnce({ items: [makeActor(), makeActor(), makeActor()] });
        const result = await searchAgentSafeActors({
            keywords: 'foo',
            apifyClient: stubApifyClient,
            limit: 3,
            offset: 0,
        });
        expect(listMock).toHaveBeenCalledWith({ search: 'foo', limit: 3, offset: 0 });
        expect(paramsHolder.params).toMatchObject({ includeInputSchema: true });
        expect(result).toHaveLength(3);
    });

    it('forwards allowsAgenticUsers when paymentProvider is set', async () => {
        listMock.mockResolvedValueOnce({ items: [makeActor()] });
        await searchAgentSafeActors({
            keywords: 'foo',
            apifyClient: stubApifyClient,
            limit: 1,
            offset: 0,
            // The actual provider is not consumed here; only its presence flips the flag.
            paymentProvider: {} as never,
        });
        expect(paramsHolder.params).toMatchObject({ allowsAgenticUsers: true, includeInputSchema: true });
    });
});
