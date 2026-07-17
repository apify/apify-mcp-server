import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { describe, expect, it, vi } from 'vitest';

import type { ApifyClient } from '../../src/apify_client.js';
import { fetchActorDetails, typeObjectToString } from '../../src/utils/actor_details.js';

vi.mock('../../src/utils/actor_search.js', () => ({
    searchActorsByKeywords: vi.fn().mockResolvedValue([]),
}));

function apifyApiError(status: number, message: string): ApifyApiError {
    return new ApifyApiError({ data: { error: { type: message, message } }, status } as AxiosResponse, 1);
}

function stubApifyClient(getActor: () => Promise<unknown>): ApifyClient {
    return {
        token: 'test-token',
        actor: () => ({
            get: getActor,
            defaultBuild: async () => ({ get: getActor }),
        }),
    } as unknown as ApifyClient;
}

describe('typeObjectToString', () => {
    it('formats a flat object of string-typed fields', () => {
        expect(typeObjectToString({ name: 'string', age: 'number' })).toBe('{ name: string, age: number }');
    });

    it('formats an array of primitives', () => {
        expect(typeObjectToString({ tags: ['string'] })).toBe('{ tags: string[] }');
    });

    it('formats an array of objects', () => {
        expect(typeObjectToString({ users: [{ name: 'string' }] })).toBe('{ users: { name: string }[] }');
    });

    it('formats a nested object', () => {
        expect(typeObjectToString({ profile: { name: 'string', age: 'number' } })).toBe(
            '{ profile: { name: string, age: number } }',
        );
    });

    it('formats deep nesting through arrays and objects', () => {
        expect(typeObjectToString({ a: [{ b: ['string'] }] })).toBe('{ a: { b: string[] }[] }');
    });

    it('returns empty braces for an empty object', () => {
        expect(typeObjectToString({})).toBe('{  }');
    });

    it('returns "unknown[]" for an empty array', () => {
        expect(typeObjectToString({ tags: [] })).toBe('{ tags: unknown[] }');
    });

    it('skips fields with null / number / boolean / undefined values at top level', () => {
        expect(
            typeObjectToString({
                a: null,
                b: 42,
                c: true,
                d: undefined,
                keep: 'string',
            }),
        ).toBe('{ keep: string }');
    });

    it('emits "unknown" for non-string primitives nested inside arrays', () => {
        expect(typeObjectToString({ nums: [42] })).toBe('{ nums: unknown[] }');
    });

    it('formats nested arrays', () => {
        expect(typeObjectToString({ matrix: [['string']] })).toBe('{ matrix: string[][] }');
    });

    it('emits "unknown" for null nested inside an array', () => {
        expect(typeObjectToString({ a: [null] })).toBe('{ a: unknown[] }');
    });

    it('mixes kept string/object/array fields with skipped primitives in one object', () => {
        expect(
            typeObjectToString({
                name: 'string',
                count: 5,
                tags: ['string'],
                meta: { id: 'string' },
                flag: false,
            }),
        ).toBe('{ name: string, tags: string[], meta: { id: string } }');
    });

    it('emits "unknown" for function / symbol nested inside an array', () => {
        expect(typeObjectToString({ fns: [() => 1] as unknown[] })).toBe('{ fns: unknown[] }');
        expect(typeObjectToString({ syms: [Symbol('x')] as unknown[] })).toBe('{ syms: unknown[] }');
    });

    it('formats triple-nested arrays', () => {
        expect(typeObjectToString({ cube: [[['string']]] })).toBe('{ cube: string[][][] }');
    });

    it('formats an array whose element is an empty object', () => {
        expect(typeObjectToString({ items: [{}] })).toBe('{ items: {  }[] }');
    });

    it('recurses through a nested object containing mixed skipped values', () => {
        expect(
            typeObjectToString({
                outer: {
                    keep: 'string',
                    skip: 42,
                    tags: ['string'],
                },
            }),
        ).toBe('{ outer: { keep: string, tags: string[] } }');
    });
});

describe('fetchActorDetails()', () => {
    it('returns null on a genuine 404 (Actor does not exist)', async () => {
        const client = stubApifyClient(() => Promise.reject(apifyApiError(404, 'Actor was not found')));

        const result = await fetchActorDetails(client, 'apify/no-such-actor');

        expect(result).toBeNull();
    });

    it('propagates a 401 (invalid/expired token) instead of reporting not-found', async () => {
        const client = stubApifyClient(() => Promise.reject(apifyApiError(401, 'Authentication token is not valid')));

        await expect(fetchActorDetails(client, 'apify/instagram-scraper')).rejects.toMatchObject({ statusCode: 401 });
    });
});
