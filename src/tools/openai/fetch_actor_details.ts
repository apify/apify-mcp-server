import { ApifyClient } from '../../apify_client.js';
import { getWidgetConfig, WIDGET_URIS } from '../../resources/widgets.js';
import type { InternalToolArgs, ToolEntry } from '../../types.js';
import {
    buildActorNotFoundResponse,
    buildCardOptions,
    fetchActorDetails,
    processActorDetailsForResponse,
    resolveOutputOptions,
} from '../../utils/actor_details.js';
import { buildMCPResponse } from '../../utils/mcp.js';
import { cleanActorIdOrName } from '../core/actor_tools_factory.js';
import {
    fetchActorDetailsMetadata,
    fetchActorDetailsToolArgsSchema,
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
        const actorName = cleanActorIdOrName(parsed.actor, { mcpSessionId, route: 'fetch-actor-details' });
        const apifyClient = new ApifyClient({ token: apifyToken });

        const resolvedOutput = resolveOutputOptions(parsed.output);
        const cardOptions = buildCardOptions(resolvedOutput);

        const details = await fetchActorDetails(apifyClient, actorName, cardOptions);
        if (!details) {
            return buildActorNotFoundResponse(actorName);
        }

        const { structuredContent: processedStructuredContent, actorUrl } = processActorDetailsForResponse(details);
        const structuredContent = {
            actorInfo: details.actorCardStructured,
            inputSchema: details.inputSchema,
            actorDetails: processedStructuredContent.actorDetails,
        };

        const texts = [`
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
