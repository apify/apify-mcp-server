import dedent from 'dedent';
import { z } from 'zod';

import { ApifyClient } from '../../apify_client.js';
import { HelperTools } from '../../const.js';
import { getWidgetConfig, WIDGET_URIS } from '../../resources/widgets.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import {
    buildActorDetailsForWidget,
    buildCardOptions,
    fetchActorDetails,
} from '../../utils/actor_details.js';
import { compileSchema } from '../../utils/ajv.js';
import { buildMCPResponse } from '../../utils/mcp.js';
import { getUserInfoCached } from '../../utils/userid_cache.js';
import { fixActorNameInputAndLog } from '../core/actor_tools_factory.js';
import {
    actorDetailsOutputDefaults,
    buildActorNotFoundResponse,
} from '../core/fetch_actor_details_common.js';
import { actorDetailsWidgetOutputSchema } from '../structured_output_schemas.js';

/**
 * Widget-only input: `actor` only. `.strict()` rejects stray keys such as `output`
 * so callers can't smuggle the base tool's options into the widget variant.
 */
const fetchActorDetailsWidgetArgsSchema = z.object({
    actor: z.string()
        .min(1)
        .describe('Actor ID or full name in the format "username/name", e.g., "apify/rag-web-browser".'),
}).strict();

const FETCH_ACTOR_DETAILS_WIDGET_DESCRIPTION = dedent`
    Render an interactive UI element (widget) displaying detailed Actor information for the user.

    Use this tool ONLY when the user explicitly wants to see or browse Actor details
    (e.g., "show me apify/rag-web-browser", "tell me about this Actor", "what does apify/web-scraper look like").
    The response renders as an interactive widget the user can view directly.

    For silent data lookups (e.g., fetching the input schema before calling an Actor, inspecting README
    for decision making), use ${HelperTools.ACTOR_GET_DETAILS} instead — it returns the same data
    without rendering a widget.

    Input: the Actor ID or full name only. Output fields are fixed by the widget contract.
`;

export const fetchActorDetailsWidgetTool: ToolEntry = Object.freeze({
    type: 'internal',
    name: HelperTools.ACTOR_GET_DETAILS_WIDGET,
    description: FETCH_ACTOR_DETAILS_WIDGET_DESCRIPTION,
    inputSchema: z.toJSONSchema(fetchActorDetailsWidgetArgsSchema) as ToolInputSchema,
    outputSchema: actorDetailsWidgetOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(fetchActorDetailsWidgetArgsSchema)),
    // Tool-level widget meta; only registered in apps mode so stripWidgetMeta is a no-op here.
    _meta: {
        ...getWidgetConfig(WIDGET_URIS.SEARCH_ACTORS)?.meta,
    },
    annotations: {
        title: 'Fetch Actor details (widget)',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyToken, mcpSessionId } = toolArgs;
        const parsed = fetchActorDetailsWidgetArgsSchema.parse(args);
        const actorName = fixActorNameInputAndLog(parsed.actor, { mcpSessionId, route: HelperTools.ACTOR_GET_DETAILS_WIDGET });
        const apifyClient = new ApifyClient({ token: apifyToken });

        const { userPlanTier } = await getUserInfoCached(apifyToken, apifyClient);
        const cardOptions = { ...buildCardOptions(actorDetailsOutputDefaults), userTier: userPlanTier };
        const details = await fetchActorDetails(apifyClient, actorName, cardOptions);
        if (!details) {
            return buildActorNotFoundResponse(actorName);
        }

        const { actorUrl, actorDetails } = buildActorDetailsForWidget(details, userPlanTier);
        const structuredContent = {
            actorDetails: {
                actorInfo: actorDetails.actorInfo,
                readme: actorDetails.readme,
            },
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
            // Response-level meta; only returned in apps mode (this handler is apps-only).
            _meta: {
                ...widgetConfig?.meta,
                'openai/widgetDescription': `Actor details for ${actorName} from Apify Store`,
            },
        });
    },
} as const);
