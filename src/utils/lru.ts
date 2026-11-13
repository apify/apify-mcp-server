/**
 * Cache that holds at most `maxLength` entries and evicts the least recently used one when full.
 *
 * Entries are kept in a `Map`, which iterates in insertion order: the first key is always the least
 * recently used one, and any string is a valid key.
 */
export class LruCache<T> {
    private readonly entries = new Map<string, T>();

    constructor(private readonly maxLength: number) {}

    /** Returns the value and marks the entry as the most recently used, or returns null if the key is not stored. */
    get(key: string): T | null {
        if (!this.entries.has(key)) return null;
        const value = this.entries.get(key) as T;
        this.entries.delete(key);
        this.entries.set(key, value);
        return value;
    }

    /** Stores the value as the most recently used entry, replacing any value already stored under the key. */
    set(key: string, value: T): void {
        this.entries.delete(key);
        this.entries.set(key, value);
        if (this.entries.size <= this.maxLength) return;
        const leastRecentlyUsedKey = this.entries.keys().next().value;
        if (leastRecentlyUsedKey !== undefined) this.entries.delete(leastRecentlyUsedKey);
    }

    delete(key: string): void {
        this.entries.delete(key);
    }

    clear(): void {
        this.entries.clear();
    }
}
