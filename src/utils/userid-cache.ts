import { createHash } from 'node:crypto';

import type { ApifyClient } from '../apify-client.js';
import { USER_CACHE_MAX_SIZE, USER_CACHE_TTL_SECS } from '../const.js';
import { TTLLRUCache } from './ttl-lru.js';

// LRU cache with TTL for user info - stores the raw User object from API
const userIdCache = new TTLLRUCache<string>(USER_CACHE_MAX_SIZE, USER_CACHE_TTL_SECS);

/**
 * Gets user ID from token, using cache to avoid repeated API calls
 * Token is hashed before caching to avoid storing raw tokens
 * Returns userId or null if not found
 */
export async function getUserIdFromTokenCached(
    token: string,
    apifyClient: ApifyClient,
): Promise<string | null> {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const cachedId = userIdCache.get(tokenHash);
    if (cachedId) return cachedId;

    try {
        const user = await apifyClient.user('me').get();
        if (!user || !user.id) {
            return null;
        }
        userIdCache.set(tokenHash, user.id);
        return user.id;
    } catch {
        return null;
    }
}
