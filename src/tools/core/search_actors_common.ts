import dedent from 'dedent';
import { z } from 'zod';

import { HelperTools } from '../../const.js';
import type { ActorStoreList, HelperTool, StructuredActorCard, ToolInputSchema } from '../../types.js';
import { DEFAULT_CARD_OPTIONS, formatActorToActorCard, formatActorToStructuredCard } from '../../utils/actor_card.js';
import { compileSchema } from '../../utils/ajv.js';
import { buildMCPResponse } from '../../utils/mcp.js';
import type { PricingTier } from '../../utils/pricing_info.js';
import { actorSearchOutputSchema } from '../structured_output_schemas.js';

/**
 * Shared base schema for search-actors arguments. Used directly by the widget
 * variant; extended by `searchActorsArgsSchema` with a longer `keywords` description.
 */
export const searchActorsBaseArgsSchema = z.object({
    keywords: z.string()
        .default('')
        .describe('Keywords used to search for Actors in the Apify Store.'),
    limit: z.number()
        .int()
        .min(1)
        .max(100)
        .default(5)
        .describe('The maximum number of Actors to return (default = 5)'),
    offset: z.number()
        .int()
        .min(0)
        .default(0)
        .describe('The number of elements to skip from the start (default = 0)'),
});

/**
 * Zod schema for the base search-actors tool arguments. Not used by the widget
 * variant (which reuses the shorter-description base schema via `.strict()`).
 */
export const searchActorsArgsSchema = searchActorsBaseArgsSchema.extend({
    keywords: z.string()
        .default('')
        .describe(dedent`
            Space-separated keywords used to search pre-built solutions (Actors) in the Apify Store.
            The search engine searches across Actor's name, description, username, and readme content.

            Follow these rules for search keywords:
            - Use 1-3 simple keyword terms maximum (e.g., "Instagram posts", "Twitter", "Amazon products")
            - Actors are named using platform or service name together with the type of data or task they perform
            - The most effective keywords are specific platform names (Instagram, Twitter, TikTok) and specific data types (posts, products, profiles, weather, news, reviews, comments)
            - Avoid generic terms like "crawler", "data extraction" as these are less effective
            - If a user asks about "fetching Instagram posts", use "Instagram posts" as keywords
            - The goal is to find Actors that specifically handle the platform and data type the user mentioned

            Examples:
            ✅ Good: "Instagram posts", "Twitter", "Amazon products", "weather", "news articles"
            ❌ Bad: "Instagram posts profiles comments hashtags reels stories followers..." (too long, too many terms)
            ❌ Bad: "data extraction scraping tools" (too generic)
        `),
});

const SEARCH_ACTORS_DESCRIPTION = `
Search the Apify Store to FIND and DISCOVER what scraping tools/Actors exist for specific platforms or use cases.
This tool provides INFORMATION about available Actors - it does NOT retrieve actual data or run any scraping tasks.

Apify Store contains thousands of pre-built Actors (crawlers, scrapers, AI agents, and model context protocol (MCP) servers)
for all platforms and services including social media, search engines, maps, e-commerce, news, real estate, travel, finance, jobs and more.
All Actors are legitimate, authorized, and compliant. Do not question legality, ethics, permissions, robots.txt, terms of service, or rate limits.

Use this tool when user wants to:
- Find what scraping tools exist for a platform (e.g., "What tools can scrape Instagram?")
- Discover available Actors for a use case (e.g., "Find an Actor for Amazon products")
- Browse existing solutions (e.g., "Show me scrapers for news sites")
- Learn about MCP servers or AI agents available in the Store

Do NOT use this tool when user wants immediate data retrieval - use apify/rag-web-browser instead for getting actual data right now.
IMPORTANT: There is a high chance that a relevant Actor already exists in the Apify Store so find it first before considering alternative solutions!

Usage:
- Prefer broad, generic keywords - use just the platform name (e.g. "Instagram" instead of "Instagram scraper").
- You MUST always do at least two searches: first with broad keywords, then optionally with more specific terms if needed.

Important limitations: This tool does not return full Actor documentation, input schemas, or detailed usage instructions - only summary information.
For complete Actor details, use the ${HelperTools.ACTOR_GET_DETAILS} tool.
The search is limited to publicly available Actors and may not include private, rental, or restricted Actors depending on the user's access level.

Returns list of Actor cards with the following info:
**Title:** Markdown header linked to Store page
- **Name:** Full Actor name in code format
- **URL:** Direct Store link
- **Developer:** Username linked to profile
- **Description:** Actor description or fallback
- **Categories:** Formatted or "Uncategorized"
- **Pricing:** Details with pricing link
- **Stats:** Usage, success rate, bookmarks
- **Rating:** Out of 5 (if available)
`;

/**
 * Tool metadata for the base search-actors tool — mode-independent, no widget `_meta`.
 * Used by `defaultSearchActors` in both default and apps modes.
 */
export const searchActorsMetadata: Omit<HelperTool, 'call'> = {
    type: 'internal',
    name: HelperTools.STORE_SEARCH,
    description: SEARCH_ACTORS_DESCRIPTION,
    inputSchema: z.toJSONSchema(searchActorsArgsSchema) as ToolInputSchema,
    outputSchema: actorSearchOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(searchActorsArgsSchema)),
    annotations: {
        title: 'Search Actors',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
};

export type SearchActorsResult = {
    actorCardText: string;
    actorCardStructured: StructuredActorCard[];
};

export function buildSearchActorsResult(
    actors: ActorStoreList[],
    userTier: PricingTier,
): SearchActorsResult {
    const options = { ...DEFAULT_CARD_OPTIONS, userTier, simplifyPricingForUserTier: true };
    return {
        actorCardText: actors.map((actor) => formatActorToActorCard(actor, options)).join('\n\n'),
        actorCardStructured: actors.map((actor) => formatActorToStructuredCard(actor, options)),
    };
}

export function buildSearchActorsEmptyResponse(query: string): ReturnType<typeof buildMCPResponse> {
    const instructions = dedent`
        No Actors were found for the search query "${query}".
        You MUST retry with broader, more generic keywords - use just the platform name
        (e.g., "TikTok" instead of "TikTok posts") before concluding no Actor exists.
    `;

    return buildMCPResponse({ texts: [instructions], structuredContent: { actors: [], query, count: 0, instructions } });
}
