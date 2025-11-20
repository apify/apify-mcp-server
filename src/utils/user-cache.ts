import { createHash } from 'node:crypto';

import type { User } from 'apify-client';

import type { ApifyClient } from '../apify-client.js';
import { USER_CACHE_MAX_SIZE, USER_CACHE_TTL_SECS } from '../const.js';
import { TTLLRUCache } from './ttl-lru.js';

// LRU cache with TTL for user info - stores the raw User object from API
const userCache = new TTLLRUCache<User>(USER_CACHE_MAX_SIZE, USER_CACHE_TTL_SECS);

/**
 * Gets user info from token, using cache to avoid repeated API calls
 * Token is hashed before caching to avoid storing raw tokens
 * Returns the full User object from API or null if not found
 */
export async function getUserIdFromToken(
    token: string,
    apifyClient: ApifyClient,
): Promise<User | null> {
    // Hash token for cache key
    const tokenHash = createHash('sha256').update(token).digest('hex');

    // Check cache first
    const cachedUser = userCache.get(tokenHash);
    if (cachedUser) {
        return cachedUser;
    }

    // Fetch from API
    try {
        const user = await apifyClient.user('me').get();
        if (!user || !user.id) {
            return null;
        }

        userCache.set(tokenHash, user);
        return user;
    } catch {
        return null;
    }
}
