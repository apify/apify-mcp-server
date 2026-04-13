import dedent from 'dedent';

import { HelperTools } from '../../const.js';
import type { InternalToolArgs, ToolEntry } from '../../types.js';
import { searchAndFilterActors } from '../../utils/actor_search.js';
import { buildMCPResponse } from '../../utils/mcp.js';
import { getUserInfoCached } from '../../utils/userid_cache.js';
import {
    buildSearchActorsEmptyResponse,
    buildSearchActorsResult,
    searchActorsArgsSchema,
    searchActorsMetadata,
} from '../core/search_actors_common.js';

/**
 * Default mode search-actors tool.
 * Returns text-based Actor cards without widget metadata.
 */
export const defaultSearchActors: ToolEntry = Object.freeze({
    ...searchActorsMetadata,
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyToken, apifyClient, userRentedActorIds, apifyMcpServer } = toolArgs;
        const parsed = searchActorsArgsSchema.parse(args);
        const actors = await searchAndFilterActors({
            keywords: parsed.keywords,
            apifyToken,
            limit: parsed.limit,
            offset: parsed.offset,
            paymentProvider: apifyMcpServer.options.paymentProvider,
            userRentedActorIds,
        });

        if (actors.length === 0) {
            return buildSearchActorsEmptyResponse(parsed.keywords);
        }

        const { userPlanTier } = await getUserInfoCached(apifyToken, apifyClient);
        const { actorCardText, actorCardStructured } = buildSearchActorsResult(actors, userPlanTier);
        const structuredContent = {
            actors: actorCardStructured,
            query: parsed.keywords,
            count: actors.length,
            instructions: dedent`
                If you need more detailed information about any of these Actors, including their
                input schemas and usage instructions, please use the ${HelperTools.ACTOR_GET_DETAILS}
                tool with the specific Actor name.
                IMPORTANT: You MUST always do a second search with broader, more generic keywords
                (e.g., just the platform name like "TikTok" instead of "TikTok posts") to make sure
                you haven't missed a better Actor.
            `,
        };

        const instructions = dedent`
            # Search results:
            - **Search query:** ${parsed.keywords}
            - **Number of Actors found:** ${actors.length}

            # Actors:

            ${actorCardText}

            If you need more detailed information about any of these Actors, including their input
            schemas and usage instructions, use the ${HelperTools.ACTOR_GET_DETAILS} tool with the
            specific Actor name.
            IMPORTANT: You MUST always do a second search with broader, more generic keywords
            (e.g., just the platform name like "TikTok" instead of "TikTok posts") to make sure
            you haven't missed a better Actor.
        `;
        return buildMCPResponse({ texts: [instructions], structuredContent });
    },
} as const);
