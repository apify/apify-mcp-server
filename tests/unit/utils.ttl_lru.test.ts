import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TTLLRUCache } from '../../src/utils/ttl_lru.js';

describe('TTLLRUCache', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('sets and gets values before TTL expires', () => {
        const cache = new TTLLRUCache<string>(2, 2); // 2 seconds TTL
        cache.set('a', 'valueA');
        expect(cache.get('a')).toBe('valueA');
    });

    it('returns null after TTL expires', () => {
        const cache = new TTLLRUCache<string>(2, 1); // 1 second TTL
        cache.set('a', 'valueA');
        vi.advanceTimersByTime(1100);
        expect(cache.get('a')).toBeNull();
    });

    it('evicts least recently used items when maxLength is exceeded', () => {
        const cache = new TTLLRUCache<string>(2, 10); // Large TTL
        cache.set('a', 'valueA');
        cache.set('b', 'valueB');
        cache.set('c', 'valueC'); // Should evict 'a'
        expect(cache.get('a')).toBeNull();
        expect(cache.get('b')).toBe('valueB');
        expect(cache.get('c')).toBe('valueC');
    });

    it('updates value and TTL on set for existing key', () => {
        const cache = new TTLLRUCache<string>(2, 1); // 1 second TTL
        cache.set('a', 'valueA');
        vi.advanceTimersByTime(700);
        cache.set('a', 'valueA2'); // Reset TTL
        vi.advanceTimersByTime(700);
        expect(cache.get('a')).toBe('valueA2');
    });

    it('removes expired entry on get', () => {
        const cache = new TTLLRUCache<string>(2, 1); // 1 second TTL
        cache.set('a', 'valueA');
        vi.advanceTimersByTime(1100);
        expect(cache.get('a')).toBeNull();
        // Should not throw if called again
        expect(cache.get('a')).toBeNull();
    });

    describe('accepts any string as a key', () => {
        const KEYS = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', ''];

        it.each(KEYS)('stores and returns a value under the key %j like any other key', (key) => {
            const ownNamesBefore = Object.getOwnPropertyNames(Object.prototype);
            try {
                const cache = new TTLLRUCache<string>(10, 10);
                cache.set('apify/rag-web-browser', 'cached');
                expect(cache.get(key)).toBeNull();
                cache.set(key, 'value');
                expect(cache.get(key)).toBe('value');
                cache.set(key, 'updated');
                expect(cache.get(key)).toBe('updated');
                expect(cache.get('apify/rag-web-browser')).toBe('cached');
                expect(Object.getOwnPropertyNames(Object.prototype)).toEqual(ownNamesBefore);
            } finally {
                restoreObjectPrototype(ownNamesBefore);
            }
        });
    });
});

/** Removes properties a failing run may have added to `Object.prototype`, so later tests are unaffected. */
function restoreObjectPrototype(ownNamesBefore: string[]) {
    for (const name of Object.getOwnPropertyNames(Object.prototype)) {
        if (!ownNamesBefore.includes(name)) delete (Object.prototype as Record<string, unknown>)[name];
    }
}
