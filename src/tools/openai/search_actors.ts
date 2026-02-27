import { HelperTools } from '../../const.js';
import { getWidgetConfig, WIDGET_URIS } from '../../resources/widgets.js';
import type { InternalToolArgs, ToolEntry } from '../../types.js';
import { formatActorForWidget, formatActorToActorCard, formatActorToStructuredCard, type WidgetActor } from '../../utils/actor_card.js';
import { searchAndFilterActors } from '../../utils/actor_search.js';
import { buildMCPResponse } from '../../utils/mcp.js';
import {
    searchActorsArgsSchema,
    searchActorsMetadata,
} from '../core/search_actors_common.js';

/**
 * OpenAI mode search-actors tool.
 * Returns widget-formatted actors with interactive widget metadata.
 */
export const openaiSearchActors: ToolEntry = Object.freeze({
    ...searchActorsMetadata,
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
You MUST retry with broader, more generic keywords - use just the platform name (e.g., "TikTok" instead of "TikTok posts") before concluding no Actor exists.`;
            const structuredContent = {
                actors: [],
                query: parsed.keywords,
                count: 0,
                instructions,
            };
            return buildMCPResponse({ texts: [instructions], structuredContent });
        }

        const structuredActorCards = actors.map((actor) => formatActorToStructuredCard(actor));
        const structuredContent: {
            actors: typeof structuredActorCards;
            query: string;
            count: number;
            instructions?: string;
            widgetActors?: WidgetActor[];
        } = {
            actors: structuredActorCards,
            query: parsed.keywords,
            count: actors.length,
            instructions: `Choosing the right details tool: Use ${HelperTools.ACTOR_GET_DETAILS} when the user wants to browse or explore Actors (e.g., "show me", "find me"). Use ${HelperTools.ACTOR_GET_DETAILS_INTERNAL} when the user wants to execute a task and you need the input schema (e.g., "scrape", "extract").
IMPORTANT: You MUST always do a second search with broader, more generic keywords (e.g., just the platform name like "TikTok" instead of "TikTok posts") to make sure you haven't missed a better Actor.`,
        };

        // Add widget-formatted actors for the interactive UI
        structuredContent.widgetActors = actors.map(formatActorForWidget);

        const actorCards = actors.map((actor) => formatActorToActorCard(actor));
        const actorsText = actorCards.join('\n\n');
        const texts = [`
 # Search results:
 - **Search query:** ${parsed.keywords}
 - **Number of Actors found:** ${actors.length}

An interactive widget has been rendered with the search results. The user can already see the list of Actors visually in the widget, so do NOT print or summarize the Actor list in your response.

 # Actors:

 ${actorsText}

## Choosing the right details tool:
- Use ${HelperTools.ACTOR_GET_DETAILS} when the user wants to **browse or explore** Actors (e.g., "show me Google Maps scrapers", "find me a TikTok scraper", "what Actors exist for LinkedIn"). This renders an interactive widget for the user.
- Use ${HelperTools.ACTOR_GET_DETAILS_INTERNAL} when the user wants to **execute a task** and you need the Actor's input schema to prepare the run (e.g., "scrape Google Maps for restaurants", "extract emails from this website"). This is a silent lookup — no widget is rendered.

IMPORTANT: You MUST always do a second search with broader, more generic keywords (e.g., just the platform name like "TikTok" instead of "TikTok posts") to make sure you haven't missed a better Actor.
`];

        const widgetConfig = getWidgetConfig(WIDGET_URIS.SEARCH_ACTORS);
        return buildMCPResponse({
            texts,
            structuredContent,
            // Response-level meta; only returned in openai mode (this handler is openai-only)
            _meta: {
                ...widgetConfig?.meta,
                'openai/widgetDescription': `Interactive actor search results showing ${actors.length} actors from Apify Store`,
            },
        });
    },
} as const);
