import { z } from 'zod';

import { ApifyClient } from '../apify-client.js';
import { HelperTools } from '../const.js';
import { getWidgetConfig, WIDGET_URIS } from '../resources/widgets.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../types.js';
import {
    actorDetailsOutputOptionsSchema,
    buildActorDetailsTextResponse,
    buildActorNotFoundResponse,
    buildCardOptions,
    fetchActorDetails,
    processActorDetailsForResponse,
    resolveOutputOptions,
} from '../utils/actor-details.js';
import { compileSchema } from '../utils/ajv.js';
import { buildMCPResponse } from '../utils/mcp.js';
import { actorDetailsOutputSchema } from './structured-output-schemas.js';

const fetchActorDetailsToolArgsSchema = z.object({
    actor: z.string()
        .min(1)
        .describe(`Actor ID or full name in the format "username/name", e.g., "apify/rag-web-browser".`),
    output: actorDetailsOutputOptionsSchema.optional()
        .describe('Specify which information to include in the response to save tokens.'),
});

export const fetchActorDetailsTool: ToolEntry = {
    type: 'internal',
    name: HelperTools.ACTOR_GET_DETAILS,
    description: `Get detailed information about an Actor by its ID or full name (format: "username/name", e.g., "apify/rag-web-browser").

Use 'output' parameter with boolean flags to control returned information:
- Default: All fields true except mcpTools
- Selective: Set desired fields to true (e.g., output: { inputSchema: true })
- Common patterns: inputSchema only, description + readme, mcpTools for MCP Actors

Use when querying Actor details, documentation, input requirements, or MCP tools.

EXAMPLES:
- What does apify/rag-web-browser do?
- What is the input schema for apify/web-scraper?
- What tools does apify/actors-mcp-server provide?`,
    inputSchema: z.toJSONSchema(fetchActorDetailsToolArgsSchema) as ToolInputSchema,
    outputSchema: actorDetailsOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(fetchActorDetailsToolArgsSchema)),
    _meta: {
        ...getWidgetConfig(WIDGET_URIS.SEARCH_ACTORS)?.meta,
    },
    annotations: {
        title: 'Fetch Actor details',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyToken, apifyMcpServer, mcpSessionId } = toolArgs;
        const parsed = fetchActorDetailsToolArgsSchema.parse(args);
        const apifyClient = new ApifyClient({ token: apifyToken });

        const resolvedOutput = resolveOutputOptions(parsed.output);
        const cardOptions = buildCardOptions(resolvedOutput);

        const details = await fetchActorDetails(apifyClient, parsed.actor, cardOptions);
        if (!details) {
            return buildActorNotFoundResponse(parsed.actor);
        }

        if (apifyMcpServer.options.uiMode === 'openai') {
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
        }

        // Fetch output schema from ActorStore if available and requested
        const actorOutputSchema = resolvedOutput.outputSchema
            ? await apifyMcpServer.actorStore?.getActorOutputSchemaAsTypeObject(parsed.actor).catch(() => null)
            : undefined;

        // NOTE: Data duplication between texts and structuredContent is intentional and required.
        // Some MCP clients only read text content, while others only read structured content.
        const { texts, structuredContent: responseStructuredContent } = await buildActorDetailsTextResponse({
            actorName: parsed.actor,
            details,
            output: resolvedOutput,
            cardOptions,
            apifyClient,
            apifyToken,
            actorOutputSchema,
            skyfireMode: apifyMcpServer?.options.skyfireMode,
            mcpSessionId,
        });

        return buildMCPResponse({ texts, structuredContent: responseStructuredContent });
    },
} as const;
