import dedent from 'dedent';
import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import { getWidgetConfig, WIDGET_URIS } from '../../resources/widgets.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { formatActorForWidget } from '../../utils/actor_card.js';
import { searchAgentSafeActors } from '../../utils/actor_search.js';
import { compileSchema } from '../../utils/ajv.js';
import { respondOk } from '../../utils/mcp.js';
import { getUserInfoCached } from '../../utils/userid_cache.js';
import {
    buildNoActorsFoundInstructions,
    buildSearchActorsResult,
    searchActorsBaseArgsSchema,
} from '../actors/search_actors.js';
import { actorSearchWidgetOutputSchema } from '../structured_output_schemas.js';

/**
 * Widget-only input: mirrors the base tool's keywords/limit/offset. `.strict()`
 * marks additional properties as disallowed; in practice the server's AJV layer
 * strips unknown keys before this schema runs, so stray keys are removed silently
 * rather than causing a hard rejection.
 */
const searchActorsWidgetArgsSchema = searchActorsBaseArgsSchema.strict();

const SEARCH_ACTORS_WIDGET_DESCRIPTION = dedent`
    Render an interactive UI element (widget) displaying Apify Store search results for the user.

    Use this tool ONLY when the user explicitly wants to browse or discover Actors visually
    (e.g., "find me scrapers for Instagram", "show me Amazon Actors", "what tools exist for Twitter").
    The response renders as an interactive widget the user can view directly.

    For silent name resolution before running an Actor (e.g., "scrape google maps" — you need to
    find the right Actor first, then fetch its schema and call it), use ${HELPER_TOOLS.STORE_SEARCH}
    instead — it returns the same data without rendering a widget.

    Input: keywords (plus optional limit/offset). Output fields are fixed by the widget contract.
`;

export const searchActorsWidget: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.STORE_SEARCH_WIDGET,
    title: 'Search Actors (widget)',
    description: SEARCH_ACTORS_WIDGET_DESCRIPTION,
    inputSchema: z.toJSONSchema(searchActorsWidgetArgsSchema) as ToolInputSchema,
    outputSchema: actorSearchWidgetOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(searchActorsWidgetArgsSchema)),
    // Tool-level widget meta; only registered in apps mode so stripWidgetMeta is a no-op here.
    _meta: {
        ...getWidgetConfig(WIDGET_URIS.SEARCH_ACTORS)?.meta,
    },
    annotations: {
        title: 'Search Actors (widget)',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyToken, apifyClient, apifyMcpServer } = toolArgs;
        const parsed = searchActorsWidgetArgsSchema.parse(args);
        // Actor search and user-info fetch are independent; run in parallel to avoid a
        // sequential round-trip on cache miss.
        const [actors, { userPlanTier }] = await Promise.all([
            searchAgentSafeActors({
                keywords: parsed.keywords,
                apifyToken,
                limit: parsed.limit,
                offset: parsed.offset,
                paymentProvider: apifyMcpServer.options.paymentProvider,
            }),
            getUserInfoCached(apifyToken, apifyClient),
        ]);

        if (actors.length === 0) {
            // Honor the widget tool's declared outputSchema: widgetActors is required, so
            // emit an empty array rather than dropping the field.
            const instructions = buildNoActorsFoundInstructions(parsed.keywords);
            return respondOk(instructions, {
                structuredContent: {
                    actors: [],
                    query: parsed.keywords,
                    count: 0,
                    widgetActors: [],
                },
            });
        }

        const { actorCardStructured } = buildSearchActorsResult(actors, userPlanTier);
        const structuredContent = {
            actors: actorCardStructured,
            query: parsed.keywords,
            count: actors.length,
            userTier: userPlanTier,
            widgetActors: actors.map((actor) => formatActorForWidget(actor, userPlanTier)),
        };

        const texts = [
            dedent`
            # Search results:
            - **Search query:** ${parsed.keywords}
            - **Number of Actors found:** ${actors.length}

            An interactive widget has been rendered with the search results. The user can already see
            the list of Actors visually in the widget, so do NOT print or summarize the Actor list
            in your response.
        `,
        ];

        const widgetConfig = getWidgetConfig(WIDGET_URIS.SEARCH_ACTORS);
        return respondOk(texts, {
            structuredContent,
            // Response-level meta; only returned in apps mode (this handler is apps-only).
            meta: {
                ...widgetConfig?.meta,
                'openai/widgetDescription': `Interactive actor search results showing ${actors.length} ${actors.length === 1 ? 'actor' : 'actors'} from Apify Store`,
            },
        });
    },
} as const);
