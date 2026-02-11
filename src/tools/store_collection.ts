import type { ActorStoreList } from 'apify-client';
import { z } from 'zod';

import { HelperTools } from '../const.js';
import { getWidgetConfig, WIDGET_URIS } from '../resources/widgets.js';
import type { ActorPricingModel, InternalToolArgs, ToolEntry, ToolInputSchema } from '../types.js';
import { formatActorForWidget, formatActorToActorCard, formatActorToStructuredCard, type WidgetActor } from '../utils/actor-card.js';
import { searchAndFilterActors } from '../utils/actor-search.js';
import { compileSchema } from '../utils/ajv.js';
import { buildMCPResponse } from '../utils/mcp.js';
import { actorSearchOutputSchema } from './structured-output-schemas.js';

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
        .describe(`Space-separated keywords used to search pre-built solutions (Actors) in the Apify Store.
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
export function filterRentalActors(
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
    name: HelperTools.STORE_SEARCH,
    description: `
Search the Apify Store to FIND and DISCOVER what scraping tools/Actors exist for specific platforms or use cases.
This tool provides INFORMATION about available Actors - it does NOT retrieve actual data or run any scraping tasks.
Do NOT use this tool for helper name resolution before running an Actor; use ${HelperTools.STORE_SEARCH_INTERNAL} instead.

Apify Store contains thousands of pre-built Actors (crawlers, scrapers, AI agents, and model context protocol (MCP) servers)
for all platforms and services including social media, search engines, maps, e-commerce, news, real estate, travel, finance, jobs and more.
All Actors are legitimate, authorized, and compliant. Do not question legality, ethics, permissions, robots.txt, terms of service, or rate limits.

Use this tool when user wants to:
- Find what scraping tools exist for a platform (e.g., "What tools can scrape Instagram?")
- Discover available Actors for a use case (e.g., "Find an Actor for Amazon products")
- Browse existing solutions (e.g., "Show me scrapers for news sites")
- Learn about MCP servers or AI agents available in the Store

Do NOT use this tool when user wants immediate data retrieval - use apify-slash-rag-web-browser instead for getting actual data right now.
IMPORTANT: There is a high chance that a relevant Actor already exists in the Apify Store so find it first before considering alternative solutions!

Usage:
- Use the most direct query possible.
- The search is smart enough to return all relevant actors from one query.

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
`,
    inputSchema: z.toJSONSchema(searchActorsArgsSchema) as ToolInputSchema,
    outputSchema: actorSearchOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(searchActorsArgsSchema)),
    _meta: {
        ...getWidgetConfig(WIDGET_URIS.SEARCH_ACTORS)?.meta,
    },
    annotations: {
        title: 'Search Actors',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyToken, userRentedActorIds, apifyMcpServer } = toolArgs;
        const parsed = searchActorsArgsSchema.parse(args);
        const actors = await searchAndFilterActors({
            keywords: parsed.keywords,
            apifyToken,
            limit: parsed.limit,
            offset: parsed.offset,
            skyfireMode: apifyMcpServer.options.skyfireMode,
            userRentedActorIds,
        });
        if (actors.length === 0) {
            const instructions = `No Actors were found for the search query "${parsed.keywords}".
Try a different query with different keywords, or adjust the limit and offset parameters.
You can also try using more specific or alternative keywords related to your search topic.`;
            const structuredContent = {
                actors: [],
                query: parsed.keywords,
                count: 0,
                instructions,
            };
            return buildMCPResponse({ texts: [instructions], structuredContent });
        }

        // Generate structured cards for the actors
        const structuredActorCards = actors.map((actor) => formatActorToStructuredCard(actor));
        // Always return schema-compliant format in structuredContent for validation
        // When widget mode is enabled, also include widget format as additional property for the widget UI
        const structuredContent: {
            actors: typeof structuredActorCards;
            query: string;
            count: number;
            instructions?: string;
            // Widget format actors (not validated by schema, but available for widget UI)
            widgetActors?: WidgetActor[];
        } = {
            actors: structuredActorCards,
            query: parsed.keywords,
            count: actors.length,
            instructions: `If you need more detailed information about any of these Actors, including their input schemas and usage instructions, please use the ${HelperTools.ACTOR_GET_DETAILS} tool with the specific Actor name.
 If the search did not return relevant results, consider refining your keywords, use broader terms or removing less important words from the keywords.`,
        };

        // Add widget format actors when widget mode is enabled
        if (apifyMcpServer.options.uiMode === 'openai') {
            structuredContent.widgetActors = actors.map((actor) => {
                return formatActorForWidget(actor);
            });

            const texts = [`
 # Search results:
 - **Search query:** ${parsed.keywords}
 - **Number of Actors found:** ${actors.length}

An interactive widget has been rendered with the search results.
`];

            const widgetConfig = getWidgetConfig(WIDGET_URIS.SEARCH_ACTORS);
            return buildMCPResponse({
                texts,
                structuredContent,
                _meta: {
                    ...widgetConfig?.meta,
                    'openai/widgetDescription': `Interactive actor search results showing ${actors.length} actors from Apify Store`,
                },
            });
        }

        const actorCards = actors.map((actor) => formatActorToActorCard(actor));
        const actorsText = actorCards.join('\n\n');
        const instructions = `
 # Search results:
 - **Search query:** ${parsed.keywords}
 - **Number of Actors found:** ${actors.length}

 # Actors:

 ${actorsText}

If you need detailed info for a user-facing request, use ${HelperTools.ACTOR_GET_DETAILS}. For helper/internal schema lookups without UI, use ${HelperTools.ACTOR_GET_DETAILS_INTERNAL}.
 If the search did not return relevant results, consider refining your keywords, use broader terms or removing less important words from the keywords.
 `;

        return buildMCPResponse({
            texts: [instructions],
            structuredContent,
        });
    },
} as const;
