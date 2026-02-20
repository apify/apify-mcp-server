import { HelperTools } from '../../const.js';
import type { InternalToolArgs, ToolEntry } from '../../types.js';
import { formatActorToActorCard, formatActorToStructuredCard } from '../../utils/actor-card.js';
import { searchAndFilterActors } from '../../utils/actor-search.js';
import { buildMCPResponse } from '../../utils/mcp.js';
import {
    searchActorsArgsSchema,
    searchActorsMetadata,
} from '../core/search-actors-common.js';

/**
 * Default mode search-actors tool.
 * Returns text-based actor cards without widget metadata.
 */
export const defaultSearchActors: ToolEntry = {
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
        const structuredContent = {
            actors: structuredActorCards,
            query: parsed.keywords,
            count: actors.length,
            instructions: `If you need more detailed information about any of these Actors, including their input schemas and usage instructions, please use the ${HelperTools.ACTOR_GET_DETAILS} tool with the specific Actor name.
IMPORTANT: You MUST always do a second search with broader, more generic keywords (e.g., just the platform name like "TikTok" instead of "TikTok posts") to make sure you haven't missed a better Actor.`,
        };

        const actorCards = actors.map((actor) => formatActorToActorCard(actor));
        const actorsText = actorCards.join('\n\n');
        const instructions = `
 # Search results:
 - **Search query:** ${parsed.keywords}
 - **Number of Actors found:** ${actors.length}

 # Actors:

 ${actorsText}

If you need detailed info for a user-facing request, use ${HelperTools.ACTOR_GET_DETAILS}. For helper/internal schema lookups without UI, use ${HelperTools.ACTOR_GET_DETAILS_INTERNAL}.
IMPORTANT: You MUST always do a second search with broader, more generic keywords (e.g., just the platform name like "TikTok" instead of "TikTok posts") to make sure you haven't missed a better Actor.
 `;

        return buildMCPResponse({
            texts: [instructions],
            structuredContent,
        });
    },
} as const;
