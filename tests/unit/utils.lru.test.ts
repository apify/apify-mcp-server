import { describe, expect, it } from 'vitest';

import { LruCache } from '../../src/utils/lru.js';

describe('LruCache', () => {
    it('returns null for a missing key', () => {
        const cache = new LruCache<string>(2);
        expect(cache.get('a')).toBeNull();
    });

    it('evicts the least recently used entry when full', () => {
        const cache = new LruCache<string>(2);
        cache.set('a', 'valueA');
        cache.set('b', 'valueB');
        cache.get('a'); // 'b' is now the least recently used entry.
        cache.set('c', 'valueC');
        expect(cache.get('b')).toBeNull();
        expect(cache.get('a')).toBe('valueA');
        expect(cache.get('c')).toBe('valueC');
    });

    it('replaces the value of an existing key without evicting another entry', () => {
        const cache = new LruCache<string>(2);
        cache.set('a', 'old');
        cache.set('b', 'valueB');
        cache.set('a', 'new');
        expect(cache.get('a')).toBe('new');
        expect(cache.get('b')).toBe('valueB');
        cache.set('a', 'newer'); // 'b' is now the least recently used entry.
        cache.set('c', 'valueC');
        expect(cache.get('b')).toBeNull();
        expect(cache.get('a')).toBe('newer');
    });

    it('deletes an entry', () => {
        const cache = new LruCache<string>(2);
        cache.set('a', 'valueA');
        cache.delete('a');
        expect(cache.get('a')).toBeNull();
    });

    it('clears all entries', () => {
        const cache = new LruCache<string>(2);
        cache.set('a', 'first');
        cache.set('b', 'second');

        cache.clear();

        expect(cache.get('a')).toBeNull();
        expect(cache.get('b')).toBeNull();
    });

    it('reports how many entries it holds', () => {
        const cache = new LruCache<string>(2);
        expect(cache.size).toBe(0);

        cache.set('a', 'first');
        cache.set('b', 'second');
        cache.set('c', 'third');

        expect(cache.size).toBe(2);
    });

    it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])(
        'treats the built-in property name %s as an ordinary key',
        (key) => {
            const cache = new LruCache<string>(2);
            expect(cache.get(key)).toBeNull();
            cache.set(key, 'value');
            expect(cache.get(key)).toBe('value');
            cache.delete(key);
            expect(cache.get(key)).toBeNull();
            expect(Object.keys(Object.prototype)).toEqual([]);
        },
    );
});
