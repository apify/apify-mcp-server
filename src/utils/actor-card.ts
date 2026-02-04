import type { Actor } from 'apify-client';

import { APIFY_STORE_URL } from '../const.js';
import type { ActorCardOptions, ExtendedActorStoreList, ExtendedPricingInfo, StructuredActorCard } from '../types.js';
import { getCurrentPricingInfo, pricingInfoToString, pricingInfoToStructured } from './pricing-info.js';

// Helper function to format categories from uppercase with underscores to proper case
function formatCategories(categories?: string[]): string[] {
    if (!categories) return [];

    return categories.map((category) => {
        const formatted = category
            .toLowerCase()
            .split('_')
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
        // Special case for MCP server, AI, and SEO tools
        return formatted.replace('Mcp Server', 'MCP Server').replace('Ai', 'AI').replace('Seo', 'SEO');
    });
}

/**
 * Formats Actor details into an Actor card (Actor information in markdown).
 * @param actor - Actor information from the API
 * @param options - Options to control which sections to include in the card
 * @returns Formatted actor card
 */
export function formatActorToActorCard(
    actor: Actor | ExtendedActorStoreList,
    options: ActorCardOptions = {
        includeDescription: true,
        includeStats: true,
        includePricing: true,
        includeRating: true,
        includeMetadata: true,
    },
): string {
    const actorFullName = `${actor.username}/${actor.name}`;
    const actorUrl = `${APIFY_STORE_URL}/${actorFullName}`;

    // Build the markdown lines - always include title and URL
    const markdownLines = [
        `## [${actor.title}](${actorUrl}) (\`${actorFullName}\`)`,
        `- **URL:** ${actorUrl}`,
    ];

    // Add description text only
    if (options.includeDescription) {
        markdownLines.push(`- **Description:** ${actor.description || 'No description provided.'}`);
    }

    // Add pricing info
    if (options.includePricing) {
        let pricingInfo: string;
        if ('currentPricingInfo' in actor) {
            // ActorStoreList has currentPricingInfo
            pricingInfo = pricingInfoToString(actor.currentPricingInfo as ExtendedPricingInfo);
        } else {
            // Actor has pricingInfos array
            const currentPricingInfo = getCurrentPricingInfo(actor.pricingInfos || [], new Date());
            pricingInfo = pricingInfoToString(currentPricingInfo as (ExtendedPricingInfo | null));
        }
        markdownLines.push(`- **[Pricing](${actorUrl}/pricing):** ${pricingInfo}`);
    }

    // Add stats - handle different stat structures
    if (options.includeStats && 'stats' in actor) {
        const { stats } = actor;
        const statsParts = [];

        if ('totalUsers' in stats && 'totalUsers30Days' in stats) {
            // Both Actor and ActorStoreList have the same stats structure
            statsParts.push(`${stats.totalUsers.toLocaleString()} total users, ${stats.totalUsers30Days.toLocaleString()} monthly users`);
        }

        // Add success rate for last 30 days if available
        if ('publicActorRunStats30Days' in stats && stats.publicActorRunStats30Days) {
            const runStats = stats.publicActorRunStats30Days as {
                SUCCEEDED: number;
                TOTAL: number;
            };
            if (runStats.TOTAL > 0) {
                const successRate = ((runStats.SUCCEEDED / runStats.TOTAL) * 100).toFixed(1);
                statsParts.push(`Runs succeeded: ${successRate}%`);
            }
        }

        // Add bookmark count if available (from ActorStoreList or Actor.stats)
        const bookmarkCount = ('bookmarkCount' in actor && actor.bookmarkCount)
            || ('bookmarkCount' in stats && stats.bookmarkCount);
        if (bookmarkCount) {
            statsParts.push(`${bookmarkCount} bookmarks`);
        }

        if (statsParts.length > 0) {
            markdownLines.push(`- **Stats:** ${statsParts.join(', ')}`);
        }
    }

    // Add rating if available (from ActorStoreList or Actor.stats)
    if (options.includeRating) {
        const rating = ('actorReviewRating' in actor && actor.actorReviewRating)
            || ('stats' in actor && actor.stats && 'actorReviewRating' in actor.stats && actor.stats.actorReviewRating);
        if (rating) {
            markdownLines.push(`- **Rating:** ${Number(rating).toFixed(2)} out of 5`);
        }
    }

    // Add metadata (developer, categories, modification date, deprecation warning)
    if (options.includeMetadata) {
        // Add developer info
        markdownLines.push(`- **Developed by:** [${actor.username}](${APIFY_STORE_URL}/${actor.username}) ${actor.username === 'apify' ? '(Apify)' : '(community)'}`);

        // Add categories
        const formattedCategories = formatCategories('categories' in actor ? actor.categories : undefined);
        markdownLines.push(`- **Categories:** ${formattedCategories.length ? formattedCategories.join(', ') : 'Uncategorized'}`);

        // Add modification date if available
        if ('modifiedAt' in actor) {
            markdownLines.push(`- **Last modified:** ${actor.modifiedAt.toISOString()}`);
        }

        // Add deprecation warning if applicable
        if ('isDeprecated' in actor && actor.isDeprecated) {
            markdownLines.push('\n>This Actor is deprecated and may not be maintained anymore.');
        }
    }

    return markdownLines.join('\n');
}

/**
 * Extracts structured data from Actor information.
 * @param actor - Actor information from the API
 * @param options - Options to control which sections to include in the card
 * @returns Structured actor card data for programmatic use
 */
export function formatActorToStructuredCard(
    actor: Actor | ExtendedActorStoreList,
    options: ActorCardOptions = {
        includeDescription: true,
        includeStats: true,
        includePricing: true,
        includeRating: true,
        includeMetadata: true,
    },
): StructuredActorCard {
    const actorFullName = `${actor.username}/${actor.name}`;
    const actorUrl = `${APIFY_STORE_URL}/${actorFullName}`;

    // Build structured data - always include title, url, fullName
    const structuredData: StructuredActorCard = {
        title: actor.title,
        url: actorUrl,
        fullName: actorFullName,
        developer: {
            username: '',
            isOfficialApify: false,
            url: '',
        },
        description: '',
        categories: [],
        pricing: { model: 'FREE', isFree: true },
        isDeprecated: false,
    };

    // Add description text only
    if (options.includeDescription) {
        structuredData.description = actor.description || 'No description provided.';
    }

    // Add pricing info
    if (options.includePricing) {
        let pricingInfo: ExtendedPricingInfo | null = null;
        if ('currentPricingInfo' in actor) {
            // ActorStoreList has currentPricingInfo
            pricingInfo = actor.currentPricingInfo as unknown as ExtendedPricingInfo;
        } else if ('pricingInfos' in actor && actor.pricingInfos && actor.pricingInfos.length > 0) {
            // Actor has pricingInfos array - get the current one
            pricingInfo = getCurrentPricingInfo(actor.pricingInfos, new Date()) as unknown as ExtendedPricingInfo;
        }
        // If pricingInfo is still null, it means the actor is free (no pricing info means free)
        structuredData.pricing = pricingInfoToStructured(pricingInfo);
    }

    // Add metadata (deprecation warning)
    if (options.includeMetadata) {
        structuredData.isDeprecated = ('isDeprecated' in actor && actor.isDeprecated) || false;
    }

    // Add stats if available
    if (options.includeStats && 'stats' in actor) {
        const { stats } = actor;
        if ('totalUsers' in stats && 'totalUsers30Days' in stats) {
            structuredData.stats = {
                totalUsers: stats.totalUsers,
                monthlyUsers: stats.totalUsers30Days,
            };

            // Add success rate for last 30 days if available
            if ('publicActorRunStats30Days' in stats && stats.publicActorRunStats30Days) {
                const runStats = stats.publicActorRunStats30Days as {
                    SUCCEEDED: number;
                    TOTAL: number;
                };
                if (runStats.TOTAL > 0) {
                    structuredData.stats.successRate = Number(((runStats.SUCCEEDED / runStats.TOTAL) * 100).toFixed(1));
                }
            }

            // Add bookmark count if available (from ActorStoreList or Actor.stats)
            const bookmarkCount = ('bookmarkCount' in actor && actor.bookmarkCount)
                || ('bookmarkCount' in stats && stats.bookmarkCount);
            if (bookmarkCount) {
                structuredData.stats.bookmarks = Number(bookmarkCount);
            }
        }
    }

    // Add rating if available (from ActorStoreList or Actor.stats)
    if (options.includeRating) {
        const rating = ('actorReviewRating' in actor && actor.actorReviewRating)
            || ('stats' in actor && actor.stats && 'actorReviewRating' in actor.stats && actor.stats.actorReviewRating);
        if (rating) {
            structuredData.rating = Number(rating);
        }
    }

    // Add metadata (developer, categories, modification date, deprecation)
    if (options.includeMetadata) {
        // Add developer info
        structuredData.developer = {
            username: actor.username,
            isOfficialApify: actor.username === 'apify',
            url: `${APIFY_STORE_URL}/${actor.username}`,
        };

        // Add categories
        const formattedCategories = formatCategories('categories' in actor ? actor.categories : undefined);
        structuredData.categories = formattedCategories;

        // Add modification date if available
        if ('modifiedAt' in actor && actor.modifiedAt) {
            structuredData.modifiedAt = actor.modifiedAt.toISOString();
        }

        // Add deprecation status
        structuredData.isDeprecated = ('isDeprecated' in actor && actor.isDeprecated) || false;
    }

    return structuredData;
}

/**
 * Formats Actor from store list into the structure needed by widget UI components.
 * This is used by store_collection when widget mode is enabled.
 * @param actor - Actor information from the store API
 * @returns Formatted actor data for widget UI
 */
export function formatActorForWidget(
    actor: ExtendedActorStoreList,
): {
    id: string;
    name: string;
    username: string;
    userPictureUrl?: string;
    fullName: string;
    title: string;
    description: string;
    categories: string[];
    pictureUrl: string;
    stats: {
        totalBuilds: number;
        totalRuns: number;
        totalUsers: number;
        totalBookmarks: number;
    };
    actorReviewRating?: number;
    actorReviewCount?: number;
    currentPricingInfo: {
        pricingModel: string;
        pricePerResultUsd: number;
        monthlyChargeUsd: number;
    };
    userActorRuns: {
        successRate: number | null;
    };
} {
    // Calculate success rate from publicActorRunStats30Days if available
    let successRate: number | null = null;
    const actorStats = actor.stats as typeof actor.stats & {
        publicActorRunStats30Days?: {
            SUCCEEDED: number;
            TOTAL: number;
        };
    };
    if (actorStats?.publicActorRunStats30Days) {
        const runStats = actorStats.publicActorRunStats30Days;
        if (runStats.TOTAL > 0) {
            successRate = Math.round((runStats.SUCCEEDED / runStats.TOTAL) * 100);
        }
    }

    const pricingInfo = actor.currentPricingInfo as ExtendedPricingInfo | undefined;
    const pricing = {
        pricingModel: pricingInfo?.pricingModel || 'FREE',
        pricePerResultUsd: pricingInfo?.pricePerUnitUsd || 0,
        monthlyChargeUsd: pricingInfo?.pricingModel === 'FLAT_PRICE_PER_MONTH' ? (pricingInfo?.pricePerUnitUsd || 0) : 0,
    };

    // Handle tiered pricing
    if (pricingInfo?.pricingModel === 'PRICE_PER_DATASET_ITEM' && pricingInfo.tieredPricing) {
        const tieredEntries = Object.values(pricingInfo.tieredPricing);
        if (tieredEntries.length > 0 && tieredEntries[0]) {
            pricing.pricePerResultUsd = tieredEntries[0].tieredPricePerUnitUsd || 0;
        }
    }

    return {
        id: actor.id,
        name: actor.name,
        username: actor.username,
        userPictureUrl: actor.userPictureUrl || undefined, // TODO haha we need to query the user now T_T
        userFullName: actor.user?.fullName || undefined,
        fullName: `${actor.username}/${actor.name}`,
        title: actor.title || actor.name,
        description: actor.description || 'No description available',
        categories: actor.categories || [],
        pictureUrl: actor.pictureUrl || '',
        stats: {
            totalBuilds: actor.stats?.totalBuilds || 0,
            totalRuns: actor.stats?.totalRuns || 0,
            totalUsers: actor.stats?.totalUsers || 0,
            totalBookmarks: actor.bookmarkCount || 0,
        },
        // @ts-expect-error - outdated types on actor
        actorReviewRating: actor.actorReviewRating || actor.stats?.actorReviewRating,
        // @ts-expect-error - outdated types on actor
        actorReviewCount: actor.actorReviewCount || actor.stats?.actorReviewCount,
        currentPricingInfo: pricing,
        userActorRuns: {
            successRate,
        },
    };
}
