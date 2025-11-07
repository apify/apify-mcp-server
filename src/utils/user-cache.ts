import { createHash } from 'node:crypto';

import type { User } from 'apify-client';

import type { ApifyClient } from '../apify-client.js';

// Type for cached user info - stores the raw User object from API
const userCache = new Map<string, User>();

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
    if (userCache.has(tokenHash)) {
        return userCache.get(tokenHash)!;
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
