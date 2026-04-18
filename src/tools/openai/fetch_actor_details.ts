import dedent from 'dedent';

import { ApifyClient } from '../../apify_client.js';
import { getWidgetConfig, WIDGET_URIS } from '../../resources/widgets.js';
import type { InternalToolArgs, ToolEntry } from '../../types.js';
import {
    buildActorDetailsForWidget,
    buildCardOptions,
    fetchActorDetails,
} from '../../utils/actor_details.js';
import { buildMCPResponse } from '../../utils/mcp.js';
import { getUserInfoCached } from '../../utils/userid_cache.js';
import { fixActorNameInputAndLog } from '../core/actor_tools_factory.js';
import {
    buildActorNotFoundResponse,
    fetchActorDetailsMetadata,
    fetchActorDetailsToolArgsSchema,
    resolveOutputOptions,
} from '../core/fetch_actor_details_common.js';

/**
 * OpenAI mode fetch-actor-details tool.
 * Returns simplified structured content with interactive widget metadata.
 */
export const openaiFetchActorDetails: ToolEntry = Object.freeze({
    ...fetchActorDetailsMetadata,
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyToken, mcpSessionId } = toolArgs;
        const parsed = fetchActorDetailsToolArgsSchema.parse(args);
        const actorName = fixActorNameInputAndLog(parsed.actor, { mcpSessionId, route: 'fetch-actor-details' });
        const apifyClient = new ApifyClient({ token: apifyToken });

        const { userPlanTier } = await getUserInfoCached(apifyToken, apifyClient);
        const cardOptions = { ...buildCardOptions(resolveOutputOptions(parsed.output)), userTier: userPlanTier };
        const details = await fetchActorDetails(apifyClient, actorName, cardOptions);
        if (!details) {
            return buildActorNotFoundResponse(actorName);
        }

        const { actorUrl, actorDetails } = buildActorDetailsForWidget(details, userPlanTier);
        // Pricing is already carried by `actorDetails.actorInfo.currentPricingInfo` (widget-facing,
        // tier-aware simplified). Omit the complete-mode `pricing` field from the top-level
        // `actorInfo` to avoid two conflicting pricing shapes in the same response.
        const { pricing: _pricing, ...actorInfoWithoutPricing } = details.actorCardStructured;
        const structuredContent = {
            actorInfo: actorInfoWithoutPricing,
            inputSchema: details.inputSchema,
            actorDetails,
        };

        const texts = [dedent`
            # Actor information:
            - **Actor:** ${actorName}
            - **URL:** ${actorUrl}

            An interactive widget has been rendered with detailed Actor information.
        `];

        const widgetConfig = getWidgetConfig(WIDGET_URIS.SEARCH_ACTORS);
        return buildMCPResponse({
            texts,
            structuredContent,
            // Response-level meta; only returned in openai mode (this handler is openai-only)
            _meta: {
                ...widgetConfig?.meta,
                'openai/widgetDescription': `Actor details for ${actorName} from Apify Store`,
            },
        });
    },
} as const);
