import { ApifyClient } from '../../apify_client.js';
import type { InternalToolArgs, ToolEntry } from '../../types.js';
import {
    buildActorDetailsTextResponse,
    buildActorNotFoundResponse,
    buildCardOptions,
    fetchActorDetails,
    resolveOutputOptions,
} from '../../utils/actor_details.js';
import { buildMCPResponse } from '../../utils/mcp.js';
import { fixActorNameInputAndLog } from '../core/actor_tools_factory.js';
import {
    fetchActorDetailsMetadata,
    fetchActorDetailsToolArgsSchema,
} from '../core/fetch_actor_details_common.js';

/**
 * Default mode fetch-actor-details tool.
 * Returns full text response with output schema fetch.
 */
export const defaultFetchActorDetails: ToolEntry = Object.freeze({
    ...fetchActorDetailsMetadata,
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyToken, apifyMcpServer, mcpSessionId } = toolArgs;
        const parsedArgs = fetchActorDetailsToolArgsSchema.parse(args);
        const actorName = fixActorNameInputAndLog(parsedArgs.actor, { mcpSessionId, route: 'fetch-actor-details' });
        const apifyClient = new ApifyClient({ token: apifyToken });

        const resolvedOutput = resolveOutputOptions(parsedArgs.output);
        const cardOptions = buildCardOptions(resolvedOutput);

        const details = await fetchActorDetails(apifyClient, actorName, cardOptions);
        if (!details) {
            return buildActorNotFoundResponse(actorName);
        }

        // Fetch output schema from ActorStore if available and requested
        const actorOutputSchema = resolvedOutput.outputSchema
            ? await apifyMcpServer.actorStore?.getActorOutputSchemaAsTypeObject(actorName).catch(() => null)
            : undefined;

        // NOTE: Data duplication between texts and structuredContent is intentional and required.
        // Some MCP clients only read text content, while others only read structured content.
        const { texts, structuredContent: responseStructuredContent } = await buildActorDetailsTextResponse({
            actorName,
            details,
            output: resolvedOutput,
            cardOptions,
            apifyClient,
            apifyToken,
            actorOutputSchema,
            paymentProvider: apifyMcpServer?.options.paymentProvider,
            mcpSessionId,
        });

        return buildMCPResponse({ texts, structuredContent: responseStructuredContent });
    },
} as const);
