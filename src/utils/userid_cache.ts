import { createHash } from 'node:crypto';

import type { ApifyClient } from '../apify_client.js';
import { USER_CACHE_MAX_SIZE, USER_CACHE_TTL_SECS } from '../const.js';
import { PRICING_TIERS, type PricingTier } from './pricing_info.js';
import { TTLLRUCache } from './ttl_lru.js';

export type CachedUserInfo = {
    userId: string | null;
    userPlanTier: PricingTier;
};

// LRU cache with TTL for user info - keyed by hashed token
const userInfoCache = new TTLLRUCache<CachedUserInfo>(USER_CACHE_MAX_SIZE, USER_CACHE_TTL_SECS);

function normalizePlanTier(tier: string | undefined): PricingTier {
    const upper = tier?.toUpperCase();
    return PRICING_TIERS.find((t) => t === upper) ?? 'FREE';
}

/**
 * Gets user info (id + plan tier) from token, using cache to avoid repeated API calls.
 * Token is hashed before caching to avoid storing raw tokens.
 *
 * Defensive defaults: `userPlanTier` is always present. Returns 'FREE' when the plan
 * is missing, unrecognized, or the API call fails. Failed lookups are NOT cached so
 * the next call retries.
 */
export async function getUserInfoCached(
    token: string,
    apifyClient: ApifyClient,
): Promise<CachedUserInfo> {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const cached = userInfoCache.get(tokenHash);
    if (cached) return cached;

    try {
        const user = await apifyClient.user('me').get();
        // `tier` is present on /v2/users/me `plan` response (FREE/BRONZE/SILVER/GOLD/PLATINUM/DIAMOND)
        // but missing from apify-client's type declaration — hence the cast.
        const planTier = (user?.plan as { tier?: string } | undefined)?.tier;
        const info: CachedUserInfo = {
            userId: user?.id ?? null,
            userPlanTier: normalizePlanTier(planTier),
        };
        userInfoCache.set(tokenHash, info);
        return info;
    } catch {
        return { userId: null, userPlanTier: 'FREE' };
    }
}
