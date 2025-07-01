import { describe, expect, it } from 'vitest';

import { TTLLRUCache } from '../../src/utils/ttl-lru.js';

describe('TTLLRUCache', () => {
    it('should set and get values before TTL expires', () => {
        const cache = new TTLLRUCache<string>(2, 2); // 2 seconds TTL
        cache.set('a', 'valueA');
        expect(cache.get('a')).toBe('valueA');
    });

    it('should return null after TTL expires', async () => {
        const cache = new TTLLRUCache<string>(2, 1); // 1 second TTL
        cache.set('a', 'valueA');
        await new Promise((r) => { setTimeout(r, 1100); });
        expect(cache.get('a')).toBeNull();
    });

    it('should evict least recently used items when maxLength is exceeded', () => {
        const cache = new TTLLRUCache<string>(2, 10); // Large TTL
        cache.set('a', 'valueA');
        cache.set('b', 'valueB');
        cache.set('c', 'valueC'); // Should evict 'a'
        expect(cache.get('a')).toBeNull();
        expect(cache.get('b')).toBe('valueB');
        expect(cache.get('c')).toBe('valueC');
    });

    it('should update value and TTL on set for existing key', async () => {
        const cache = new TTLLRUCache<string>(2, 1); // 1 second TTL
        cache.set('a', 'valueA');
        await new Promise((r) => { setTimeout(r, 700); });
        cache.set('a', 'valueA2'); // Reset TTL
        await new Promise((r) => { setTimeout(r, 700); });
        expect(cache.get('a')).toBe('valueA2');
    });

    it('should remove expired entry on get', async () => {
        const cache = new TTLLRUCache<string>(2, 1); // 1 second TTL
        cache.set('a', 'valueA');
        await new Promise((r) => { setTimeout(r, 1100); });
        expect(cache.get('a')).toBeNull();
        // Should not throw if called again
        expect(cache.get('a')).toBeNull();
    });
});
