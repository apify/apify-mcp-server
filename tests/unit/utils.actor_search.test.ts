import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActorStoreList } from '../../src/types.js';
import { searchActorsByKeywords, searchAndFilterActors } from '../../src/utils/actor_search.js';

const listMock = vi.fn();
const paramsHolder: { params: Record<string, unknown> } = { params: {} };

vi.mock('../../src/apify_client.js', () => ({
    ApifyClient: vi.fn().mockImplementation(() => ({
        store: () => ({
            get params(): Record<string, unknown> { return paramsHolder.params; },
            set params(value: Record<string, unknown>) { paramsHolder.params = value; },
            list: listMock,
        }),
    })),
}));

function makeActor(idSuffix: number): ActorStoreList {
    return {
        id: `id-${idSuffix}`,
        name: `actor-${idSuffix}`,
        username: 'user',
        currentPricingInfo: { pricingModel: 'FREE' },
        stats: {},
    } as unknown as ActorStoreList;
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
            apifyToken: 'tok',
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
        await searchActorsByKeywords({ search: 'foo', apifyToken: 'tok' });
        expect(paramsHolder.params).not.toHaveProperty('includeInputSchema');
        expect(paramsHolder.params).not.toHaveProperty('allowsAgenticUsers');
    });

    it('forwards `limit` verbatim — caller is responsible for the API cap', async () => {
        listMock.mockResolvedValueOnce({ items: [] });
        await searchActorsByKeywords({ search: 'foo', apifyToken: 'tok', limit: 5 });
        expect(listMock).toHaveBeenCalledWith({ search: 'foo', limit: 5, offset: undefined });
    });
});

describe('searchAndFilterActors', () => {
    beforeEach(() => {
        listMock.mockReset();
        paramsHolder.params = {};
    });

    it('always sets includeInputSchema=true (public limit is capped at the API max)', async () => {
        listMock.mockResolvedValueOnce({ items: [makeActor(1), makeActor(2), makeActor(3)] });
        const result = await searchAndFilterActors({
            keywords: 'foo',
            apifyToken: 'tok',
            limit: 3,
            offset: 0,
        });
        expect(listMock).toHaveBeenCalledWith({ search: 'foo', limit: 3, offset: 0 });
        expect(paramsHolder.params).toMatchObject({ includeInputSchema: true });
        expect(result).toHaveLength(3);
    });

    it('forwards allowsAgenticUsers when paymentProvider is set', async () => {
        listMock.mockResolvedValueOnce({ items: [makeActor(1)] });
        await searchAndFilterActors({
            keywords: 'foo',
            apifyToken: 'tok',
            limit: 1,
            offset: 0,
            // The actual provider is not consumed here; only its presence flips the flag.
            paymentProvider: {} as never,
        });
        expect(paramsHolder.params).toMatchObject({ allowsAgenticUsers: true, includeInputSchema: true });
    });
});
