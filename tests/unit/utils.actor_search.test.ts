import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ACTOR_PRICING_MODEL, STORE_INPUT_SCHEMA_PAGE_LIMIT } from '../../src/const.js';
import type { ActorStoreList } from '../../src/types.js';
import { filterRentalActors, searchAndFilterActors } from '../../src/utils/actor_search.js';

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

function makeActor(idSuffix: number, pricingModel: string = ACTOR_PRICING_MODEL.FREE): ActorStoreList {
    return {
        id: `id-${idSuffix}`,
        name: `actor-${idSuffix}`,
        username: 'user',
        currentPricingInfo: { pricingModel },
        stats: {},
    } as unknown as ActorStoreList;
}

describe('filterRentalActors', () => {
    it('drops rental actors that the user has not rented', () => {
        const actors = [
            makeActor(1, ACTOR_PRICING_MODEL.FREE),
            makeActor(2, ACTOR_PRICING_MODEL.FLAT_PRICE_PER_MONTH),
            makeActor(3, ACTOR_PRICING_MODEL.PAY_PER_EVENT),
        ];
        const filtered = filterRentalActors(actors, []);
        expect(filtered.map((a) => a.id)).toEqual(['id-1', 'id-3']);
    });

    it('keeps rental actors that the user has rented', () => {
        const actors = [
            makeActor(1, ACTOR_PRICING_MODEL.FLAT_PRICE_PER_MONTH),
            makeActor(2, ACTOR_PRICING_MODEL.FLAT_PRICE_PER_MONTH),
        ];
        expect(filterRentalActors(actors, ['id-1']).map((a) => a.id)).toEqual(['id-1']);
    });
});

describe('searchAndFilterActors', () => {
    beforeEach(() => {
        listMock.mockReset();
        paramsHolder.params = {};
    });

    it('passes includeInputSchema=true and a page-sized limit to the API', async () => {
        listMock.mockResolvedValueOnce({ items: [makeActor(1), makeActor(2), makeActor(3)] });
        const result = await searchAndFilterActors({
            keywords: 'foo',
            apifyToken: 'tok',
            limit: 3,
            offset: 0,
        });
        expect(listMock).toHaveBeenCalledTimes(1);
        expect(listMock).toHaveBeenCalledWith({ search: 'foo', limit: STORE_INPUT_SCHEMA_PAGE_LIMIT, offset: 0 });
        expect(paramsHolder.params).toMatchObject({ includeInputSchema: true });
        expect(result).toHaveLength(3);
    });

    it('paginates when the first page does not yield enough non-rental actors', async () => {
        // First page: all rentals → 0 non-rentals; second page: 3 non-rentals.
        listMock
            .mockResolvedValueOnce({ items: Array.from({ length: 10 }, (_, i) => makeActor(i, ACTOR_PRICING_MODEL.FLAT_PRICE_PER_MONTH)) })
            .mockResolvedValueOnce({ items: [makeActor(100), makeActor(101), makeActor(102)] });
        const result = await searchAndFilterActors({
            keywords: 'foo',
            apifyToken: 'tok',
            limit: 3,
            offset: 0,
        });
        expect(listMock).toHaveBeenCalledTimes(2);
        expect(listMock.mock.calls[1][0]).toMatchObject({ offset: 10 });
        expect(result.map((a) => a.id)).toEqual(['id-100', 'id-101', 'id-102']);
    });

    it('returns at most `limit` actors even when more are accumulated across pages', async () => {
        listMock
            .mockResolvedValueOnce({ items: Array.from({ length: 10 }, (_, i) => makeActor(i)) })
            .mockResolvedValueOnce({ items: Array.from({ length: 10 }, (_, i) => makeActor(i + 100)) });
        const result = await searchAndFilterActors({
            keywords: 'foo',
            apifyToken: 'tok',
            limit: 5,
            offset: 0,
        });
        // First page already covers `limit`; no second call should happen.
        expect(listMock).toHaveBeenCalledTimes(1);
        expect(result).toHaveLength(5);
    });

    it('short-circuits when a page returns fewer items than requested (end of upstream results)', async () => {
        // Single rental in a 10-slot page → upstream has nothing more; should not roundtrip again.
        listMock.mockResolvedValueOnce({ items: [makeActor(1, ACTOR_PRICING_MODEL.FLAT_PRICE_PER_MONTH)] });
        const result = await searchAndFilterActors({
            keywords: 'foo',
            apifyToken: 'tok',
            limit: 5,
            offset: 0,
        });
        expect(listMock).toHaveBeenCalledTimes(1);
        expect(result).toEqual([]);
    });

    it('stops on an empty page when previous pages were full (rentals burned the budget)', async () => {
        listMock
            .mockResolvedValueOnce({ items: Array.from({ length: 10 }, (_, i) => makeActor(i, ACTOR_PRICING_MODEL.FLAT_PRICE_PER_MONTH)) })
            .mockResolvedValueOnce({ items: [] });
        const result = await searchAndFilterActors({
            keywords: 'foo',
            apifyToken: 'tok',
            limit: 5,
            offset: 0,
        });
        expect(listMock).toHaveBeenCalledTimes(2);
        expect(result).toEqual([]);
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
