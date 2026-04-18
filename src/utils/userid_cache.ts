import { createHash } from 'node:crypto';

import log from '@apify/log';

import type { ApifyClient } from '../apify_client.js';
import { USER_CACHE_MAX_SIZE, USER_CACHE_TTL_SECS } from '../const.js';
import { PRICING_TIERS, type PricingTier } from './pricing_info.js';
import { TTLLRUCache } from './ttl_lru.js';

export type CachedUserInfo = {
    userId: string | null;
    userPlanTier: PricingTier;
};

const ANONYMOUS_USER_INFO: CachedUserInfo = { userId: null, userPlanTier: 'FREE' };

// LRU cache with TTL for user info - keyed by hashed token
const userInfoCache = new TTLLRUCache<CachedUserInfo>(USER_CACHE_MAX_SIZE, USER_CACHE_TTL_SECS);

function normalizePlanTier(tier: string | undefined): PricingTier {
    if (!tier) return 'FREE';
    const upper = tier.toUpperCase();
    const match = PRICING_TIERS.find((t) => t === upper);
    if (match) return match;
    // Enterprise / custom plan names fall through to FREE; log so we can spot them in the wild.
    log.info(`Unrecognized plan tier "${tier}", defaulting to FREE`);
    return 'FREE';
}

/**
 * Gets user info (id + plan tier) from token, using cache to avoid repeated API calls.
 * Token is hashed before caching to avoid storing raw tokens.
 *
 * Defensive defaults: returns `{ userId: null, userPlanTier: 'FREE' }` when the token is
 * missing/empty, the API call fails, or the plan is unrecognized. Failed lookups are NOT
 * cached so the next call retries.
 */
export async function getUserInfoCached(
    token: string | undefined,
    apifyClient: ApifyClient,
): Promise<CachedUserInfo> {
    if (!token) return ANONYMOUS_USER_INFO;
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const cached = userInfoCache.get(tokenHash);
    if (cached) return cached;

    try {
        const user = await apifyClient.user('me').get();
        if (!user?.id) {
            return { ...ANONYMOUS_USER_INFO };
        }
        // `tier` is present on /v2/users/me `plan` response (FREE/BRONZE/SILVER/GOLD/PLATINUM/DIAMOND)
        // but missing from apify-client's type declaration — hence the cast.
        const planTier = (user.plan as { tier?: string } | undefined)?.tier;
        const info: CachedUserInfo = {
            userId: user.id,
            userPlanTier: normalizePlanTier(planTier),
        };
        userInfoCache.set(tokenHash, info);
        return info;
    } catch {
        return { ...ANONYMOUS_USER_INFO };
    }
}
