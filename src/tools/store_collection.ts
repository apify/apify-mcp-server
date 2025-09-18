import type { ActorStoreList } from 'apify-client';
import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

import { ApifyClient } from '../apify-client.js';
import { ACTOR_SEARCH_ABOVE_LIMIT, HelperTools } from '../const.js';
import type { ActorPricingModel, ExtendedActorStoreList, HelperTool, ToolEntry } from '../types.js';
import { formatActorsListToActorCard } from '../utils/actor-card.js';
import { ajv } from '../utils/ajv.js';

export async function searchActorsByKeywords(
    search: string,
    apifyToken: string,
    limit: number | undefined = undefined,
    offset: number | undefined = undefined,
): Promise<ExtendedActorStoreList[]> {
    const client = new ApifyClient({ token: apifyToken });
    const results = await client.store().list({ search, limit, offset });
    return results.items;
}

export const searchActorsArgsSchema = z.object({
    limit: z.number()
        .int()
        .min(1)
        .max(100)
        .default(10)
        .describe('The maximum number of Actors to return. The default value is 10.'),
    offset: z.number()
        .int()
        .min(0)
        .default(0)
        .describe('The number of elements to skip at the start. The default value is 0.'),
    search: z.string()
        .default('')
        .describe(`A string to search for in the Actor's title, name, description, username, and readme.
Use simple space-separated keywords, such as "web scraping", "data extraction", or "playwright browser mcp".
Do not use complex queries, AND/OR operators, or other advanced syntax, as this tool uses full-text search only.`),
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
        description: `Search the Apify Store for Actors or Model Context Protocol (MCP) servers using keywords.
Apify Store features solutions for web scraping, automation, and AI agents (e.g., Instagram, TikTok, LinkedIn, flights, bookings).

The results will include curated Actor cards with title, description, pricing model, usage statistics, and ratings.
For best results, use simple space-separated keywords (e.g., "instagram posts", "twitter profile", "playwright mcp").
For detailed information about a specific Actor, use the ${HelperTools.ACTOR_GET_DETAILS} tool.

USAGE:
- Use when you need to discover Actors for a specific task or find MCP servers.
- Use to explore available tools in the Apify ecosystem based on keywords.

EXAMPLES:
- user_input: Find Actors for scraping e-commerce
- user_input: Find browserbase MCP server
- user_input: I need to scrape instagram profiles and comments
- user_input: I need to get flights and airbnb data`,
        inputSchema: zodToJsonSchema(searchActorsArgsSchema),
        ajvValidate: ajv.compile(zodToJsonSchema(searchActorsArgsSchema)),
        call: async (toolArgs) => {
            const { args, apifyToken, userRentedActorIds } = toolArgs;
            const parsed = searchActorsArgsSchema.parse(args);
            let actors = await searchActorsByKeywords(
                parsed.search,
                apifyToken,
                parsed.limit + ACTOR_SEARCH_ABOVE_LIMIT,
                parsed.offset,
            );
            actors = filterRentalActors(actors || [], userRentedActorIds || []).slice(0, parsed.limit);
            const actorCards = formatActorsListToActorCard(actors);
            return {
                content: [
                    {
                        type: 'text',
                        text: `**Search query:** ${parsed.search}\n\n`
                              + `**Number of Actors found:** ${actorCards.length}\n\n`
                              + `**Actor cards:**\n${actorCards.join('\n\n')}`,
                    },
                ],
            };
        },
    } as HelperTool,
};
