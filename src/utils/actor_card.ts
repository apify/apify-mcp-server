import { APIFY_STORE_URL } from '../const.js';
import type { Actor, ActorCardOptions, ActorStoreList, StructuredActorCard } from '../types.js';
import {
    getCurrentPricingInfo,
    type PricingInfo,
    pricingInfoToSimplifiedString,
    pricingInfoToSimplifiedStructured,
    pricingInfoToString,
    pricingInfoToStructured,
    type PricingTier,
    type StructuredPricingInfo,
} from './pricing_info.js';

// Helper function to format categories from uppercase with underscores to a proper case
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
 * Resolves pricing info from either ActorStoreList (has currentPricingInfo)
 * or Actor (has pricingInfos array).
 */
function getActorPricingInfo(actor: Actor | ActorStoreList): PricingInfo | null {
    if ('currentPricingInfo' in actor) {
        return actor.currentPricingInfo;
    }
    return getCurrentPricingInfo(actor.pricingInfos || [], new Date());
}

export const DEFAULT_CARD_OPTIONS: ActorCardOptions = {
    includeDescription: true,
    includeStats: true,
    includePricing: true,
    includeRating: true,
    includeMetadata: true,
};

/**
 * Private intermediate representation holding all extracted actor data.
 * Preserves raw PricingInfo so both markdown (pricingInfoToString) and
 * structured (pricingInfoToStructured) conversions produce correct output.
 */
type ExtractedActorData = {
    actorFullName: string;
    actorUrl: string;
    title?: string;
    pictureUrl?: string;
    description: string;
    pricingInfo: PricingInfo | null;
    stats?: {
        totalUsers: number;
        monthlyUsers: number;
        successRate?: number;
        bookmarks?: number;
    };
    rating?: {
        average: number;
        count: number;
    };
    developer: {
        username: string;
        isOfficialApify: boolean;
        url: string;
    };
    categories: string[];
    modifiedAt?: string;
    isDeprecated: boolean;
};

/**
 * Extracts all actor data into a normalized intermediate form.
 * Both formatActorToActorCard and formatActorToStructuredCard consume this.
 */
function extractActorData(
    actor: Actor | ActorStoreList,
    options: ActorCardOptions,
): ExtractedActorData {
    const actorFullName = `${actor.username}/${actor.name}`;
    const actorUrl = `${APIFY_STORE_URL}/${actorFullName}`;

    const data: ExtractedActorData = {
        actorFullName,
        actorUrl,
        title: actor.title,
        pictureUrl: actor.pictureUrl || undefined,
        description: options.includeDescription
            ? (actor.description || 'No description provided.')
            : '',
        pricingInfo: options.includePricing ? getActorPricingInfo(actor) : null,
        developer: { username: '', isOfficialApify: false, url: '' },
        categories: [],
        isDeprecated: false,
    };

    // Extract stats — each field checked independently to match original markdown behavior
    if (options.includeStats && 'stats' in actor) {
        const { stats } = actor;

        if ('totalUsers' in stats && 'totalUsers30Days' in stats) {
            data.stats = {
                totalUsers: stats.totalUsers,
                monthlyUsers: stats.totalUsers30Days,
            };
        }

        if ('publicActorRunStats30Days' in stats && stats.publicActorRunStats30Days) {
            const runStats = stats.publicActorRunStats30Days as {
                SUCCEEDED: number;
                TOTAL: number;
            };
            if (runStats.TOTAL > 0) {
                data.stats ??= { totalUsers: 0, monthlyUsers: 0 };
                data.stats.successRate = Number(((runStats.SUCCEEDED / runStats.TOTAL) * 100).toFixed(1));
            }
        }

        const bookmarkCount = ('bookmarkCount' in actor && actor.bookmarkCount)
            || ('bookmarkCount' in stats && stats.bookmarkCount);
        if (bookmarkCount) {
            data.stats ??= { totalUsers: 0, monthlyUsers: 0 };
            data.stats.bookmarks = Number(bookmarkCount);
        }
    }

    // Extract rating — only actorReviewRating is required (count is optional)
    if (options.includeRating) {
        const actorReviewRating = ('actorReviewRating' in actor && actor.actorReviewRating)
            || ('stats' in actor && actor.stats && 'actorReviewRating' in actor.stats && actor.stats.actorReviewRating);
        if (actorReviewRating) {
            const actorReviewCount = ('actorReviewCount' in actor && actor.actorReviewCount)
                || ('stats' in actor && actor.stats && 'actorReviewCount' in actor.stats && actor.stats.actorReviewCount);
            data.rating = {
                average: Number(Number(actorReviewRating).toFixed(2)),
                count: actorReviewCount ? Number(actorReviewCount) : 0,
            };
        }
    }

    // Extract metadata
    if (options.includeMetadata) {
        data.developer = {
            username: actor.username,
            isOfficialApify: actor.username === 'apify',
            url: `${APIFY_STORE_URL}/${actor.username}`,
        };
        data.categories = formatCategories('categories' in actor ? actor.categories : undefined);
        if ('modifiedAt' in actor && actor.modifiedAt) {
            data.modifiedAt = actor.modifiedAt.toISOString();
        }
        data.isDeprecated = ('isDeprecated' in actor && actor.isDeprecated) || false;
    }

    return data;
}

/**
 * Formats Actor details into a markdown Actor card.
 * Used in both default (text-only) and OpenAI (widget) modes as the LLM-facing text content.
 */
export function formatActorToActorCard(
    actor: Actor | ActorStoreList,
    options: ActorCardOptions = DEFAULT_CARD_OPTIONS,
): string {
    const data = extractActorData(actor, options);
    const userTier = options.userTier ?? 'FREE';

    const markdownLines = [
        `## [${data.title}](${data.actorUrl}) (\`${data.actorFullName}\`)`,
        `- **URL:** ${data.actorUrl}`,
    ];

    if (options.includeDescription) {
        markdownLines.push(`- **Description:** ${data.description}`);
    }

    if (options.includePricing) {
        const pricingString = options.simplifyPricingForUserTier
            ? pricingInfoToSimplifiedString(data.pricingInfo, userTier)
            : pricingInfoToString(data.pricingInfo);
        markdownLines.push(`- **[Pricing](${data.actorUrl}/pricing):** ${pricingString}`);
    }

    if (data.stats) {
        const statsParts = [
            `${data.stats.totalUsers.toLocaleString()} total users, ${data.stats.monthlyUsers.toLocaleString()} monthly users`,
        ];
        if (data.stats.successRate !== undefined) {
            statsParts.push(`Runs succeeded: ${data.stats.successRate}%`);
        }
        if (data.stats.bookmarks) {
            statsParts.push(`${data.stats.bookmarks} bookmarks`);
        }
        markdownLines.push(`- **Stats:** ${statsParts.join(', ')}`);
    }

    if (data.rating) {
        markdownLines.push(`- **Rating:** ${data.rating.average.toFixed(2)} out of 5`);
    }

    if (options.includeMetadata) {
        markdownLines.push(`- **Developed by:** [${data.developer.username}](${data.developer.url}) ${data.developer.isOfficialApify ? '(Apify)' : '(community)'}`);
        markdownLines.push(`- **Categories:** ${data.categories.length ? data.categories.join(', ') : 'Uncategorized'}`);
        if (data.modifiedAt) {
            markdownLines.push(`- **Last modified:** ${data.modifiedAt}`);
        }
        if (data.isDeprecated) {
            markdownLines.push('\n>This Actor is deprecated and may not be maintained anymore.');
        }
    }
    return markdownLines.join('\n');
}

/**
 * Extracts structured Actor data for programmatic use.
 * Used in both default (text-only) and OpenAI (widget) modes as the structured content in MCP responses.
 */
export function formatActorToStructuredCard(
    actor: Actor | ActorStoreList,
    options: ActorCardOptions = DEFAULT_CARD_OPTIONS,
): StructuredActorCard {
    const data = extractActorData(actor, options);
    const userTier = options.userTier ?? 'FREE';

    const pricing = options.simplifyPricingForUserTier
        ? pricingInfoToSimplifiedStructured(data.pricingInfo, userTier)
        : pricingInfoToStructured(data.pricingInfo, userTier);

    return {
        title: data.title,
        url: data.actorUrl,
        id: actor.id,
        fullName: data.actorFullName,
        pictureUrl: data.pictureUrl,
        developer: data.developer,
        description: data.description,
        categories: data.categories,
        pricing,
        stats: data.stats,
        rating: data.rating,
        modifiedAt: data.modifiedAt,
        isDeprecated: data.isDeprecated,
    };
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
 * Formats Actor for widget UI components.
 * Used only in OpenAI (widget) mode — search results and Actor details widgets.
 *
 * Always uses simplified tier-aware pricing so the widget's top-level
 * `pricePerUnit` / `events[0].priceUsd` (which is what the widget UI renders)
 * matches the tier-filtered prices shown in the LLM text and structured output.
 */
export function formatActorForWidget(
    actor: Actor | ActorStoreList,
    userTier: PricingTier,
): WidgetActor {
    const fullName = `${actor.username}/${actor.name}`;
    return {
        id: actor.id,
        name: actor.name,
        username: actor.username,
        fullName,
        title: actor.title || actor.name,
        description: actor.description || 'No description available',
        pictureUrl: actor.pictureUrl || '',
        stats: {
            actorReviewRating: ('actorReviewRating' in actor && actor.actorReviewRating)
                || actor.stats?.actorReviewRating || 0,
            actorReviewCount: ('actorReviewCount' in actor && actor.actorReviewCount)
                || actor.stats?.actorReviewCount || 0,
            totalUsers: actor.stats?.totalUsers || 0,
        },
        url: `${APIFY_STORE_URL}/${fullName}`,
        currentPricingInfo: pricingInfoToSimplifiedStructured(getActorPricingInfo(actor), userTier),
    };
}
