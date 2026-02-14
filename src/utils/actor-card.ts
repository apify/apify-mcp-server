import { APIFY_STORE_URL } from '../const.js';
import type { Actor, ActorCardOptions, ActorStoreList, PricingInfo, StructuredActorCard } from '../types.js';
import { getCurrentPricingInfo, pricingInfoToString, pricingInfoToStructured, type StructuredPricingInfo } from './pricing-info.js';

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
    actor: Actor | ActorStoreList,
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
            pricingInfo = pricingInfoToString(actor.currentPricingInfo);
        } else {
            // Actor has pricingInfos array
            const currentPricingInfo = getCurrentPricingInfo(actor.pricingInfos || [], new Date());
            pricingInfo = pricingInfoToString(currentPricingInfo);
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
    actor: Actor | ActorStoreList,
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
    const extractedPictureUrl = (actor.pictureUrl as string | undefined) || undefined;

    const structuredData: StructuredActorCard = {
        title: actor.title,
        url: actorUrl,
        fullName: actorFullName,
        pictureUrl: extractedPictureUrl,
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
        let pricingInfo: PricingInfo | null = null;
        if ('currentPricingInfo' in actor) {
            // ActorStoreList has currentPricingInfo
            pricingInfo = actor.currentPricingInfo;
        } else if ('pricingInfos' in actor && actor.pricingInfos && actor.pricingInfos.length > 0) {
            // Actor has pricingInfos array - get the current one
            pricingInfo = getCurrentPricingInfo(actor.pricingInfos, new Date());
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
        const actorReviewRating = ('actorReviewRating' in actor && actor.actorReviewRating)
            || ('stats' in actor && actor.stats && 'actorReviewRating' in actor.stats && actor.stats.actorReviewRating);
        const actorReviewCount = ('actorReviewCount' in actor && actor.actorReviewCount)
            || ('stats' in actor && actor.stats && 'actorReviewCount' in actor.stats && actor.stats.actorReviewCount);
        if (actorReviewRating && actorReviewCount) {
            structuredData.rating = {
                average: Number(actorReviewRating),
                count: Number(actorReviewCount),
            };
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
 * Shared widget actor format type used by both search and details endpoints.
 */
export type WidgetActor = {
    id: string;
    name: string;
    username: string;
    url: string;
    fullName: string;
    title: string;
    description: string;
    pictureUrl: string;
    stats: {
        totalUsers: number;
        actorReviewRating: number;
        actorReviewCount: number;
    };
    currentPricingInfo: StructuredPricingInfo;
};

/**
 * Formats Actor from store list into the structure needed by widget UI components.
 * This is used by store_collection when widget mode is enabled.
 * @param actor - Actor information from the store API
 * @returns Formatted actor data for widget UI
 */
export function formatActorForWidget(
    actor: ActorStoreList,
): WidgetActor {
    return {
        id: actor.id,
        name: actor.name,
        username: actor.username,
        fullName: `${actor.username}/${actor.name}`,
        title: actor.title || actor.name,
        description: actor.description || 'No description available',
        pictureUrl: actor.pictureUrl || '',
        stats: {
            actorReviewRating: actor.actorReviewRating || actor.stats?.actorReviewRating || 0,
            actorReviewCount: actor.actorReviewCount || actor.stats?.actorReviewCount || 0,
            totalUsers: actor.stats?.totalUsers || 0,
        },
        url: `${APIFY_STORE_URL}/${actor.username}/${actor.name}`,
        currentPricingInfo: pricingInfoToStructured(actor.currentPricingInfo),
    };
}

/**
 * Formats full Actor details (from actor.get()) into the structure needed by widget UI components.
 * This is used by fetch-actor-details when widget mode is enabled.
 * @param actor - Full Actor information from the actor API
 * @param actorUrl - URL of the actor
 * @returns Formatted actor data for widget UI
 */
export function formatActorDetailsForWidget(
    actor: Actor,
    actorUrl: string,
): WidgetActor {
    const currentPricingInfo = getCurrentPricingInfo(actor.pricingInfos || [], new Date());

    return {
        id: actor.id,
        name: actor.name,
        username: actor.username,
        url: actorUrl,
        fullName: `${actor.username}/${actor.name}`,
        title: actor.title || actor.name,
        description: actor.description || 'No description available',
        pictureUrl: actor.pictureUrl || '',
        stats: {
            totalUsers: actor.stats?.totalUsers || 0,
            actorReviewRating: actor.stats?.actorReviewRating || 0,
            actorReviewCount: actor.stats?.actorReviewCount || 0,
        },
        currentPricingInfo: pricingInfoToStructured(currentPricingInfo),
    };
}
