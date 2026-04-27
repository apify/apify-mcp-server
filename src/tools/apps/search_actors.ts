import dedent from 'dedent';

import { HelperTools } from '../../const.js';
import { getWidgetConfig, WIDGET_URIS } from '../../resources/widgets.js';
import type { InternalToolArgs, ToolEntry } from '../../types.js';
import { formatActorForWidget, type WidgetActor } from '../../utils/actor_card.js';
import { searchAndFilterActors } from '../../utils/actor_search.js';
import { buildMCPResponse } from '../../utils/mcp.js';
import { getUserInfoCached } from '../../utils/userid_cache.js';
import { buildSearchActorsEmptyResponse, buildSearchActorsResult, searchActorsArgsSchema, searchActorsMetadata } from '../core/search_actors_common.js';

/**
 * Apps mode search-actors tool.
 * Returns widget-formatted actors with interactive widget metadata.
 */
export const appsSearchActors: ToolEntry = Object.freeze({
    ...searchActorsMetadata,
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyToken, apifyClient, userRentedActorIds, apifyMcpServer } = toolArgs;
        const parsed = searchActorsArgsSchema.parse(args);
        // Actor search and user-info fetch are independent; run in parallel to avoid a
        // sequential round-trip on cache miss.
        const [actors, { userPlanTier }] = await Promise.all([
            searchAndFilterActors({
                keywords: parsed.keywords,
                apifyToken,
                limit: parsed.limit,
                offset: parsed.offset,
                paymentProvider: apifyMcpServer.options.paymentProvider,
                userRentedActorIds,
            }),
            getUserInfoCached(apifyToken, apifyClient),
        ]);

        if (actors.length === 0) {
            return buildSearchActorsEmptyResponse(parsed.keywords);
        }

        const { actorCardText, actorCardStructured } = buildSearchActorsResult(actors, userPlanTier);
        const structuredContent: {
            actors: typeof actorCardStructured;
            query: string;
            count: number;
            instructions?: string;
            widgetActors?: WidgetActor[];
        } = {
            actors: actorCardStructured,
            query: parsed.keywords,
            count: actors.length,
            instructions: dedent`
                Choosing the right details tool: Use ${HelperTools.ACTOR_GET_DETAILS_WIDGET} when the user
                wants to see or browse Actor details — it renders an interactive UI element (widget) for the user
                (e.g., "show me", "tell me about this Actor").
                Use ${HelperTools.ACTOR_GET_DETAILS} for silent data lookups (input schema, README, metadata)
                when preparing an Actor run or making a decision (e.g., "scrape", "extract") — no UI is rendered.
                IMPORTANT: You MUST always do a second search with broader, more generic keywords
                (e.g., just the platform name like "TikTok" instead of "TikTok posts") to make sure
                you haven't missed a better Actor.
            `,
        };

        // Add widget-formatted actors for the interactive UI
        structuredContent.widgetActors = actors.map((actor) => formatActorForWidget(actor, userPlanTier));

        const texts = [dedent`
            # Search results:
            - **Search query:** ${parsed.keywords}
            - **Number of Actors found:** ${actors.length}

            An interactive widget has been rendered with the search results. The user can already see
            the list of Actors visually in the widget, so do NOT print or summarize the Actor list
            in your response.

            # Actors:

            ${actorCardText}

            ## Choosing the right details tool:
            - Use ${HelperTools.ACTOR_GET_DETAILS_WIDGET} when the user wants to **see or browse**
              an Actor (e.g., "show me apify/rag-web-browser", "tell me about this Actor"). This renders
              an **interactive UI element (widget)** the user can view directly.
            - Use ${HelperTools.ACTOR_GET_DETAILS} for **silent data lookups** — fetching the input
              schema to prepare a run, reading the README for decision making, or inspecting metadata
              (e.g., "scrape Google Maps for restaurants", "extract emails from this website"). No UI
              is rendered.

            IMPORTANT: You MUST always do a second search with broader, more generic keywords
            (e.g., just the platform name like "TikTok" instead of "TikTok posts") to make sure
            you haven't missed a better Actor.
        `];

        const widgetConfig = getWidgetConfig(WIDGET_URIS.SEARCH_ACTORS);
        return buildMCPResponse({
            texts,
            structuredContent,
            // Response-level meta; only returned in apps mode (this handler is apps-only)
            _meta: {
                ...widgetConfig?.meta,
                'openai/widgetDescription': `Interactive actor search results showing ${actors.length} actors from Apify Store`,
            },
        });
    },
} as const);
