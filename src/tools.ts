import type { ActorStoreList } from 'apify-client';
import { ApifyClient } from 'apify-client';

import { addActorToTools } from './tools/add-actors-to-tools.js';
import { discoverActorsTool } from './tools/discover-actors.js';
import { getActorsDetailsTool } from './tools/get-actors-details.js';
import { removeActorFromTools } from './tools/remove-actors-from-tools.js';
import type { ActorStorePruned, PricingInfo, ToolWrap } from './types.js';

export function getActorAutoLoadingTools(): ToolWrap[] {
    return [
        addActorToTools,
        removeActorFromTools,
    ];
}

export function getActorDiscoveryTools(): ToolWrap[] {
    return [
        discoverActorsTool,
        getActorsDetailsTool,
    ];
}

function pruneActorStoreInfo(response: ActorStoreList): ActorStorePruned {
    const stats = response.stats || {};
    const pricingInfo = (response.currentPricingInfo || {}) as PricingInfo;
    return {
        id: response.id,
        name: response.name?.toString() || '',
        username: response.username?.toString() || '',
        actorFullName: `${response.username}/${response.name}`,
        title: response.title?.toString() || '',
        description: response.description?.toString() || '',
        stats: {
            totalRuns: stats.totalRuns,
            totalUsers30Days: stats.totalUsers30Days,
            publicActorRunStats30Days: 'publicActorRunStats30Days' in stats
                ? stats.publicActorRunStats30Days : {},
        },
        currentPricingInfo: {
            pricingModel: pricingInfo.pricingModel?.toString() || '',
            pricePerUnitUsd: pricingInfo?.pricePerUnitUsd ?? 0,
            trialMinutes: pricingInfo?.trialMinutes ?? 0,
        },
        url: response.url?.toString() || '',
        totalStars: 'totalStars' in response ? (response.totalStars as number) : null,
    };
}

export async function searchActorsByKeywords(
    search: string,
    limit: number | undefined = undefined,
    offset: number | undefined = undefined,
): Promise<ActorStorePruned[] | null> {
    const client = new ApifyClient({ token: process.env.APIFY_TOKEN });
    const results = await client.store().list({ search, limit, offset });
    return results.items.map((x) => pruneActorStoreInfo(x));
}
