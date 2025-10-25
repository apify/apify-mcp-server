import type { ActorStoreList } from 'apify-client';
import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

import { ApifyClient } from '../apify-client.js';
import { ACTOR_SEARCH_ABOVE_LIMIT, HelperTools } from '../const.js';
import type { ActorPricingModel, ExtendedActorStoreList, HelperTool, ToolEntry } from '../types.js';
import { formatActorToActorCard } from '../utils/actor-card.js';
import { ajv } from '../utils/ajv.js';

export async function searchActorsByKeywords(
    search: string,
    apifyToken: string,
    limit: number | undefined = undefined,
    offset: number | undefined = undefined,
    allowsAgenticUsers: boolean | undefined = undefined,
): Promise<ExtendedActorStoreList[]> {
    const client = new ApifyClient({ token: apifyToken });
    const storeClient = client.store();
    if (allowsAgenticUsers !== undefined) storeClient.params = { ...storeClient.params, allowsAgenticUsers };

    const results = await storeClient.list({ search, limit, offset });
    return results.items;
}

export const searchActorsArgsSchema = z.object({
    limit: z.number()
        .int()
        .min(1)
        .max(100)
        .default(10)
        .describe('The maximum number of Actors to return (default = 10)'),
    offset: z.number()
        .int()
        .min(0)
        .default(0)
        .describe('The number of elements to skip from the start (default = 0)'),
    keywords: z.string()
        .default('')
        .describe(`Space-separated keywords used to search Actors in the Apify Store.
The search engine requires ALL keywords to appear in the same Actor's name, description, username, or readme content.
Keywords are case-insensitive and matched using basic text search.

The most effective keywords are specific platform names (Instagram, Twitter, TikTok, etc.)
and specific data types (posts, products, profiles, weather, news, reviews, comments, etc.). 

Avoid generic terms that are too broad and will return too many irrelevant results: "scraper", "extractor", "crawler", "data extraction", "tools", "best", "cheap", "free", "automation", "bot".

If a user asks about "fetching Instagram posts", use "Instagram posts" as keywords.
The goal is to find Actors that specifically handle the platform and data type the user mentioned.`),
    category: z.string()
        .default('')
        .describe('Filter the results by the specified category.'),
});

/**
 * Filters out actors with the 'FLAT_PRICE_PER_MONTH' pricing model (rental actors),
 * unless the actor's ID is present in the user's rented actor IDs list.
 *
 * This is necessary because the Store list API does not support filtering by multiple pricing models at once.
 *
 * @param actors - Array of ActorStorePruned objects to filter.
 * @param userRentedActorIds - Array of Actor IDs that the user has rented.
 * @returns Array of Actors excluding those with 'FLAT_PRICE_PER_MONTH' pricing model (= rental Actors),
 *  except for Actors that the user has rented (whose IDs are in userRentedActorIds).
 */
function filterRentalActors(
    actors: ActorStoreList[],
    userRentedActorIds: string[],
): ActorStoreList[] {
    // Store list API does not support filtering by two pricing models at once,
    // so we filter the results manually after fetching them.
    return actors.filter((actor) => (
        actor.currentPricingInfo.pricingModel as ActorPricingModel) !== 'FLAT_PRICE_PER_MONTH'
        || userRentedActorIds.includes(actor.id),
    );
}
/**
 * https://docs.apify.com/api/v2/store-get
 */
export const searchActors: ToolEntry = {
    type: 'internal',
    tool: {
        name: HelperTools.STORE_SEARCH,
        description: `
Search the Apify Store for Actors using keyword-based queries.
Apify Store contains thousands of pre-built Actors (crawlers, scrapers, AI agents, and model context protocol (MCP) servers).

Use this tool whenever user needs to discover Actors to scrape data, find MCP servers, or explore available solutions in the Apify store.
Actors are named using platform or service name together with the type of data or task they perform,

The search uses basic keyword matching with space-separated terms - all keywords must appear in the Actor's name (the most important), description, username, or readme.
Never include generic terms like "scraper", "crawler", "data extraction", "scraping" as these will not help find relevant Actors.
It is better to omit such generic terms entirely from the search query and decide later based on the search results.
These rules prevent too many generic results and ensure precise matches.

Important limitations: This tool does not return full Actor documentation, input schemas, or detailed usage instructions - only summary information.
For complete Actor details, use the ${HelperTools.ACTOR_GET_DETAILS} tool.
The search is limited to publicly available Actors and may not include private, rental, or restricted Actors depending on the user's access level.

Use the most direct query possible.
The search is smart enough to return all relevant actors from one query.

Returns Actor cards with the following info:
- **Title:** Markdown header linked to Store page
- **Name:** Full Actor name in code format
- **URL:** Direct Store link
- **Developer:** Username linked to profile
- **Description:** Actor description or fallback
- **Categories:** Formatted or "Uncategorized"
- **Pricing:** Details with pricing link
- **Stats:** Usage, success rate, bookmarks
- **Rating:** Out of 5 (if available)
- **Last Modified:** ISO date (if available)
- **Deprecation Warning:** If deprecated

Usage examples:
- user: Find Actors for scraping e-commerce
- user: Find browserbase MCP server
- user: I need weather data
- user: Search for flight booking tools
 `,
        inputSchema: zodToJsonSchema(searchActorsArgsSchema),
        ajvValidate: ajv.compile(zodToJsonSchema(searchActorsArgsSchema)),
        call: async (toolArgs) => {
            const { args, apifyToken, userRentedActorIds, apifyMcpServer } = toolArgs;
            const parsed = searchActorsArgsSchema.parse(args);
            let actors = await searchActorsByKeywords(
                parsed.keywords,
                apifyToken,
                parsed.limit + ACTOR_SEARCH_ABOVE_LIMIT,
                parsed.offset,
                apifyMcpServer.options.skyfireMode ? true : undefined, // allowsAgenticUsers - filters Actors available for Agentic users
            );
            actors = filterRentalActors(actors || [], userRentedActorIds || []).slice(0, parsed.limit);
            const actorCards = actors.length === 0 ? [] : actors.map(formatActorToActorCard);

            const actorsText = actorCards.length
                ? actorCards.join('\n\n')
                : 'No Actors were found for the given search query. Please try different keywords or simplify your query.';

            return {
                content: [
                    {
                        type: 'text',
                        text: `
# Search results:
- **Search query:** ${parsed.keywords}
- **Number of Actors found:** ${actorCards.length}

# Actors:

${actorsText}`,
                    },
                ],
            };
        },
    } as HelperTool,
};
