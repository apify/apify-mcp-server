import { LruCache } from '@apify/datastructures';

/**
 * Every key is stored with this prefix, so any string, including names of `Object.prototype` properties
 * such as `__proto__`, is a key of its own in `LruCache`'s plain-object store.
 */
const KEY_PREFIX = 'key:';

/**
 * LRU cache with TTL: entries expire after a set time and are checked (and evicted if expired)
 * whenever accessed.
 *
 * Usage:
 *   ```typescript
 *   const cache = new TTLLRUCache<string>(100, 60); // 100 items, 60 seconds TTL
 *   cache.set('key', 'value');
 *   const value = cache.get('key');
 *   ```
 */
export class TTLLRUCache<T> {
    private readonly cache: LruCache<{
        value: T;
        expiresAt: number;
    }>;

    private readonly ttlMillis: number;

    /**
     * @param maxLength Maximum number of items in the cache (LRU eviction)
     * @param ttlSecs Time-to-live for each entry, in seconds
     */
    constructor(maxLength: number, ttlSecs: number) {
        this.ttlMillis = ttlSecs * 1000;
        this.cache = new LruCache<{
            value: T;
            expiresAt: number;
        }>({
            maxLength,
        });
    }

    /**
     * Set a value in the cache with the given key. If the key exists, it is updated and TTL is reset.
     * @param key Cache key
     * @param value Value to store
     */
    set(key: string, value: T) {
        const cacheKey = KEY_PREFIX + key;
        if (this.cache.get(cacheKey)) {
            this.cache.remove(cacheKey);
        }
        this.cache.add(cacheKey, {
            value,
            expiresAt: Date.now() + this.ttlMillis,
        });
    }

    /**
     * Get a value from the cache by key. Returns null if not found or expired.
     * @param key Cache key
     * @returns The value if present and not expired, otherwise null
     */
    get(key: string): T | null {
        const cacheKey = KEY_PREFIX + key;
        const entry = this.cache.get(cacheKey);
        if (entry && entry.expiresAt > Date.now()) {
            return entry.value;
        }
        this.cache.remove(cacheKey);
        return null;
    }
}
