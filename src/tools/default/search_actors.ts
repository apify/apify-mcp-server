import dedent from 'dedent';

import { HelperTools } from '../../const.js';
import type { InternalToolArgs, ToolEntry } from '../../types.js';
import { searchAgentSafeActors } from '../../utils/actor_search.js';
import { resolveConsoleLinkContext, VERBATIM_LINKS_NUDGE } from '../../utils/console_link.js';
import { buildMCPResponse } from '../../utils/mcp.js';
import { getUserInfoCached } from '../../utils/userid_cache.js';
import {
    buildSearchActorsEmptyResponse,
    buildSearchActorsResult,
    searchActorsBaseArgsSchema,
    searchActorsMetadata,
} from '../core/search_actors_common.js';

/**
 * Default mode search-actors tool.
 * Returns text-based Actor cards without widget metadata.
 */
export const defaultSearchActors: ToolEntry = Object.freeze({
    ...searchActorsMetadata,
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyToken, apifyClient, apifyMcpServer } = toolArgs;
        const parsed = searchActorsBaseArgsSchema.parse(args);
        // Actor search and user-info fetch are independent; run in parallel to avoid a
        // sequential round-trip on cache miss.
        const [actors, userInfo] = await Promise.all([
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
            return buildSearchActorsEmptyResponse(parsed.keywords);
        }

        const linkContext = resolveConsoleLinkContext(apifyToken, userInfo);
        const { actorCardText, actorCardStructured } = buildSearchActorsResult(
            actors,
            userInfo.userPlanTier,
            linkContext,
        );
        const verbatimLinksNudge = linkContext ? `\n${VERBATIM_LINKS_NUDGE}` : '';
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
                you haven't missed a better Actor.${verbatimLinksNudge}
            `,
        };

        // Build header and footer with separate `dedent` calls and concatenate around
        // `actorCardText` — Actor cards may contain tab-indented lines (pay-per-event
        // pricing) that would corrupt `dedent`'s indent detection if interpolated into
        // the surrounding template.
        const header = dedent`
            # Search results:
            - **Search query:** ${parsed.keywords}
            - **Number of Actors found:** ${actors.length}

            # Actors:
        `;
        const footer = dedent`
            If you need more detailed information about any of these Actors, including their input
            schemas and usage instructions, use the ${HelperTools.ACTOR_GET_DETAILS} tool with the
            specific Actor name.
            IMPORTANT: You MUST always do a second search with broader, more generic keywords
            (e.g., just the platform name like "TikTok" instead of "TikTok posts") to make sure
            you haven't missed a better Actor.${verbatimLinksNudge}
        `;
        const texts = [`${header}\n\n${actorCardText}\n\n${footer}`];
        return buildMCPResponse({ texts, structuredContent });
    },
} as const);
