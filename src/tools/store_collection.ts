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
        .describe(`Enter space-separated keywords to search Actors by title, name, description, username, or readme.

CRITICAL: Use ONLY core platform/service names together with required data such as profiles, posts, comments.
NEVER add descriptive words like "scraper", "tool", "bot", "extractor", "extraction".
Do not use advanced syntax, operators, or complex queries; only basic full-text search is supported.
`),
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
        description: `Search the Apify Store for Actors using keyword-based queries.
This tool searches across the entire Apify Store, which contains thousands of pre-built Actors (scrapers, crawlers, model context protocol (MCP) servers, and AI agents) created by Apify and the community.

Use this tool whenever user needs to discover Actors to scrape data, find MCP servers, or explore available solutions in the Apify store.
Do NOT use this tool when users ask for detailed information about a specific Actor user already knows - use the ${HelperTools.ACTOR_GET_DETAILS} tool instead for comprehensive Actor information including full README, input schema, and detailed usage instructions

The search uses basic keyword matching with space-separated terms - all keywords must appear somewhere in the Actor's information.
Advanced search operators, regex patterns, or complex queries are not supported.

CRITICAL KEYWORD RULES:
- NEVER use general keywords such as: scraping, scraper, extractor, crawler
- NEVER add descriptive words like scraper, tool, bot, extractor to platform/service names
- Use ONLY the names such as (e.g., "Skyscanner flights", "Instagram posts", "Twitter profiles", "Airbnb")

These rules prevent too many generic results and ensure precise matches.
Always use simple space-separated keywords focusing on the core platform/service name together with required data such as profiles, posts, comments.

Important limitations: This tool does not return full Actor documentation, input schemas, or detailed usage instructions - only summary information.
For complete Actor details, use the ${HelperTools.ACTOR_GET_DETAILS} tool.
The search is limited to publicly available Actors and may not include private, rental, or restricted Actors depending on the user's access level.

The tool returns Actor cards.
Always display each Actor card in the following format:
- **Actor title:** Display as a markdown header with the Actor title linked to its Store page (e.g., "## [Actor Title](https://apify.com/username/name)")
- **Actor name:** Show the full Actor name in code format (e.g., "\`username/name\`")
- **URL:** Direct link to the Actor's Store page
- **Developer:** Developer information with username linked to their profile, indicating if it's Apify or community-developed
- **Description:** Actor description or "No description provided" if missing
- **Categories:** Formatted categories (e.g., "Web Scraping, Social Media") or "Uncategorized"
- **Pricing:** Detailed pricing information with link to pricing page
- **Stats:** Usage statistics including total users, monthly users, success rate percentage, and bookmark count
- **Rating:** Star rating out of 5 (if available)
- **Last Modified:** Modification date in ISO format (if available)
- **Deprecation Warning:** Alert if the Actor is deprecated

Usage examples:
- user: Find Actors for scraping e-commerce
- user: Find browserbase MCP server
- user: I need to scrape instagram profiles and comments
- user: I need to retrieve flights and airbnb data`,
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
