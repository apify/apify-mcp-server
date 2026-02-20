import { ApifyClient } from '../../apify-client.js';
import type { InternalToolArgs, ToolEntry } from '../../types.js';
import {
    buildActorDetailsTextResponse,
    buildActorNotFoundResponse,
    buildCardOptions,
    fetchActorDetails,
    resolveOutputOptions,
} from '../../utils/actor-details.js';
import { buildMCPResponse } from '../../utils/mcp.js';
import {
    fetchActorDetailsMetadata,
    fetchActorDetailsToolArgsSchema,
} from '../core/fetch-actor-details-common.js';

/**
 * Default mode fetch-actor-details tool.
 * Returns full text response with output schema fetch.
 */
export const defaultFetchActorDetails: ToolEntry = Object.freeze({
    ...fetchActorDetailsMetadata,
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
} as const);
