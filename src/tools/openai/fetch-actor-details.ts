import { ApifyClient } from '../../apify-client.js';
import { getWidgetConfig, WIDGET_URIS } from '../../resources/widgets.js';
import type { InternalToolArgs, ToolEntry } from '../../types.js';
import {
    buildActorNotFoundResponse,
    buildCardOptions,
    fetchActorDetails,
    processActorDetailsForResponse,
    resolveOutputOptions,
} from '../../utils/actor-details.js';
import { buildMCPResponse } from '../../utils/mcp.js';
import {
    fetchActorDetailsMetadata,
    fetchActorDetailsToolArgsSchema,
} from '../core/fetch-actor-details-common.js';

/**
 * OpenAI mode fetch-actor-details tool.
 * Returns simplified structured content with interactive widget metadata.
 */
export const openaiFetchActorDetails: ToolEntry = Object.freeze({
    ...fetchActorDetailsMetadata,
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyToken } = toolArgs;
        const parsed = fetchActorDetailsToolArgsSchema.parse(args);
        const apifyClient = new ApifyClient({ token: apifyToken });

        const resolvedOutput = resolveOutputOptions(parsed.output);
        const cardOptions = buildCardOptions(resolvedOutput);

        const details = await fetchActorDetails(apifyClient, parsed.actor, cardOptions);
        if (!details) {
            return buildActorNotFoundResponse(parsed.actor);
        }

        const { structuredContent: processedStructuredContent, actorUrl } = processActorDetailsForResponse(details);
        const structuredContent = {
            actorInfo: details.actorCardStructured,
            inputSchema: details.inputSchema,
            actorDetails: processedStructuredContent.actorDetails,
        };

        const texts = [`
# Actor information:
- **Actor:** ${parsed.actor}
- **URL:** ${actorUrl}

An interactive widget has been rendered with detailed Actor information.
`];

        const widgetConfig = getWidgetConfig(WIDGET_URIS.SEARCH_ACTORS);
        return buildMCPResponse({
            texts,
            structuredContent,
            _meta: {
                ...widgetConfig?.meta,
                'openai/widgetDescription': `Actor details for ${parsed.actor} from Apify Store`,
            },
        });
    },
} as const);
