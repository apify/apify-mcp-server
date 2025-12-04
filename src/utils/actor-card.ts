import type { Actor } from 'apify-client';

import { APIFY_STORE_URL } from '../const.js';
import type { ExtendedActorStoreList, ExtendedPricingInfo, StructuredActorCard } from '../types.js';
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
 * @returns Formatted actor card
 */
export function formatActorToActorCard(
    actor: Actor | ExtendedActorStoreList,
): string {
    // Format categories for display
    const formattedCategories = formatCategories('categories' in actor ? actor.categories : undefined);

    // Get pricing info
    let pricingInfo: string;
    if ('currentPricingInfo' in actor) {
        // ActorStoreList has currentPricingInfo
        pricingInfo = pricingInfoToString(actor.currentPricingInfo as ExtendedPricingInfo);
    } else {
        // Actor has pricingInfos array
        const currentPricingInfo = getCurrentPricingInfo(actor.pricingInfos || [], new Date());
        pricingInfo = pricingInfoToString(currentPricingInfo as (ExtendedPricingInfo | null));
    }

    const actorFullName = `${actor.username}/${actor.name}`;
    const actorUrl = `${APIFY_STORE_URL}/${actorFullName}`;

    // Build the markdown lines
    const markdownLines = [
        `## [${actor.title}](${actorUrl}) (\`${actorFullName}\`)`,
        `- **URL:** ${actorUrl}`,
        `- **Developed by:** [${actor.username}](${APIFY_STORE_URL}/${actor.username}) ${actor.username === 'apify' ? '(Apify)' : '(community)'}`,
        `- **Description:** ${actor.description || 'No description provided.'}`,
        `- **Categories:** ${formattedCategories.length ? formattedCategories.join(', ') : 'Uncategorized'}`,
        `- **[Pricing](${actorUrl}/pricing):** ${pricingInfo}`,
    ];

    // Add stats - handle different stat structures
    if ('stats' in actor) {
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

        // Add bookmark count if available (ActorStoreList only)
        if ('bookmarkCount' in actor && actor.bookmarkCount) {
            statsParts.push(`${actor.bookmarkCount} bookmarks`);
        }

        if (statsParts.length > 0) {
            markdownLines.push(`- **Stats:** ${statsParts.join(', ')}`);
        }
    }

    // Add rating if available (ActorStoreList only)
    if ('actorReviewRating' in actor && actor.actorReviewRating) {
        markdownLines.push(`- **Rating:** ${actor.actorReviewRating.toFixed(2)} out of 5`);
    }

    // Add modification date if available
    if ('modifiedAt' in actor) {
        markdownLines.push(`- **Last modified:** ${actor.modifiedAt.toISOString()}`);
    }

    // Add deprecation warning if applicable
    if ('isDeprecated' in actor && actor.isDeprecated) {
        markdownLines.push('\n>This Actor is deprecated and may not be maintained anymore.');
    }
    return markdownLines.join('\n');
}

/**
 * Extracts structured data from Actor information.
 * @param actor - Actor information from the API
 * @returns Structured actor card data for programmatic use
 */
export function formatActorToStructuredCard(
    actor: Actor | ExtendedActorStoreList,
): StructuredActorCard {
    // Format categories for display
    const formattedCategories = formatCategories('categories' in actor ? actor.categories : undefined);

    // Get pricing info - try to extract from the appropriate source
    let pricingInfo: ExtendedPricingInfo | null = null;
    if ('currentPricingInfo' in actor) {
        // ActorStoreList has currentPricingInfo
        pricingInfo = actor.currentPricingInfo as unknown as ExtendedPricingInfo;
    } else if ('pricingInfos' in actor && actor.pricingInfos && actor.pricingInfos.length > 0) {
        // Actor has pricingInfos array - get the current one
        pricingInfo = getCurrentPricingInfo(actor.pricingInfos, new Date()) as unknown as ExtendedPricingInfo;
    }
    // If pricingInfo is still null, it means the actor is free (no pricing info means free)
    const pricing = pricingInfoToStructured(pricingInfo);

    const actorFullName = `${actor.username}/${actor.name}`;
    const actorUrl = `${APIFY_STORE_URL}/${actorFullName}`;

    // Build structured data
    const structuredData: StructuredActorCard = {
        title: actor.title,
        url: actorUrl,
        fullName: actorFullName,
        developer: {
            username: actor.username,
            isOfficialApify: actor.username === 'apify',
            url: `${APIFY_STORE_URL}/${actor.username}`,
        },
        description: actor.description || 'No description provided.',
        categories: formattedCategories,
        pricing,
        isDeprecated: ('isDeprecated' in actor && actor.isDeprecated) || false,
    };

    // Add stats if available
    if ('stats' in actor) {
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

            // Add bookmark count if available (ActorStoreList only)
            if ('bookmarkCount' in actor && actor.bookmarkCount) {
                structuredData.stats.bookmarks = actor.bookmarkCount;
            }
        }
    }

    // Add rating if available (ActorStoreList only)
    if ('actorReviewRating' in actor && actor.actorReviewRating) {
        structuredData.rating = actor.actorReviewRating;
    }

    // Add modification date if available
    if ('modifiedAt' in actor && actor.modifiedAt) {
        structuredData.modifiedAt = actor.modifiedAt.toISOString();
    }

    return structuredData;
}
