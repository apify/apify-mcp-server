import { LruCache } from '@apify/datastructures';

/**
 * LRU cache with TTL (time-to-live) for storing entries.
 *
 * This class wraps an LRU cache and adds a time-to-live (TTL) expiration to each entry.
 * When an entry is accessed, it is checked for expiration and removed if expired.
 *
 * Usage:
 *   ```typescript
 *   const cache = new TTLLRUCache<string>(100, 60); // 100 items, 60 seconds TTL
 *   cache.set('key', 'value');
 *   const value = cache.get('key');
 *   ```
 */
export class TTLLRUCache<T> {
    // Internal LRU cache storing value and expiration timestamp for each entry
    private readonly cache: LruCache<{
        value: T;
        expiresAt: number;
    }>;

    // Time-to-live in milliseconds for each entry
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
        // If the key already exists, remove it to update the value and reset TTL
        if (this.cache.get(key)) {
            this.cache.remove(key);
        }
        this.cache.add(key, {
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
        const entry = this.cache.get(key);
        if (entry && entry.expiresAt > Date.now()) {
            return entry.value;
        }
        this.cache.remove(key); // Remove expired entry
        return null;
    }
}
