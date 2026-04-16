import { z } from 'zod';

import { ApifyClient } from '../../apify_client.js';
import { HelperTools } from '../../const.js';
import { getWidgetConfig, WIDGET_URIS } from '../../resources/widgets.js';
import type { HelperTool, InternalToolArgs, ToolInputSchema } from '../../types.js';
import {
    actorDetailsOutputOptionsSchema,
    buildActorDetailsTextResponse,
    buildActorNotFoundResponse,
    buildCardOptions,
    fetchActorDetails,
    getMcpToolsMessage,
    resolveOutputOptions,
} from '../../utils/actor_details.js';
import { compileSchema } from '../../utils/ajv.js';
import { buildMCPResponse } from '../../utils/mcp.js';
import { actorDetailsOutputSchema } from '../structured_output_schemas.js';
import { fixActorNameInputAndLog } from './actor_tools_factory.js';

/**
 * Zod schema for fetch-actor-details arguments — shared between default and openai variants.
 */
export const fetchActorDetailsToolArgsSchema = z.object({
    actor: z.string()
        .min(1)
        .describe(`Actor ID or full name in the format "username/name", e.g., "apify/rag-web-browser".`),
    output: actorDetailsOutputOptionsSchema.optional()
        .describe('Specify which information to include in the response to save tokens.'),
});

const FETCH_ACTOR_DETAILS_DESCRIPTION = `Get detailed information about an Actor by its ID or full name (format: "username/name", e.g., "apify/rag-web-browser").

Use 'output' parameter with boolean flags to control returned information:
- Default: All fields true except mcpTools
- Selective: Set desired fields to true (e.g., output: { inputSchema: true })
- Common patterns: inputSchema only, description + readme, mcpTools for MCP Actors

The 'readme' field returns the summary when available, full README otherwise.
Use when querying Actor details, documentation, input requirements, or MCP tools.

EXAMPLES:
- What does apify/rag-web-browser do?
- What is the input schema for apify/web-scraper?
- What tools does apify/actors-mcp-server provide?`;

/**
 * Shared tool metadata for fetch-actor-details — everything except the `call` handler.
 * Used by both default and openai variants.
 */
export const fetchActorDetailsMetadata: Omit<HelperTool, 'call'> = {
    type: 'internal',
    name: HelperTools.ACTOR_GET_DETAILS,
    description: FETCH_ACTOR_DETAILS_DESCRIPTION,
    inputSchema: z.toJSONSchema(fetchActorDetailsToolArgsSchema) as ToolInputSchema,
    outputSchema: actorDetailsOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(fetchActorDetailsToolArgsSchema)),
    // openai/* and ui keys are stripped in non-openai mode by stripWidgetMeta() in src/utils/tools.ts
    _meta: {
        ...getWidgetConfig(WIDGET_URIS.SEARCH_ACTORS)?.meta,
    },
    annotations: {
        title: 'Fetch Actor details',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
};

/**
 * Shared handler for default and internal fetch-actor-details variants.
 * Both return the same text + structured response; only the telemetry route differs.
 */
export async function buildFetchActorDetailsResult(
    toolArgs: InternalToolArgs,
    route: HelperTools.ACTOR_GET_DETAILS | HelperTools.ACTOR_GET_DETAILS_INTERNAL,
): Promise<ReturnType<typeof buildMCPResponse>> {
    const { args, apifyToken, apifyMcpServer, mcpSessionId } = toolArgs;
    const parsed = fetchActorDetailsToolArgsSchema.parse(args);
    const actorName = fixActorNameInputAndLog(parsed.actor, { mcpSessionId, route });
    const apifyClient = new ApifyClient({ token: apifyToken });

    const resolvedOutput = resolveOutputOptions(parsed.output);
    const details = await fetchActorDetails(apifyClient, actorName, buildCardOptions(resolvedOutput));
    if (!details) {
        return buildActorNotFoundResponse(actorName);
    }

    const actorOutputSchema = resolvedOutput.outputSchema
        ? await apifyMcpServer.actorStore?.getActorOutputSchemaAsTypeObject(actorName).catch(() => null)
        : undefined;
    const mcpToolsMessage = resolvedOutput.mcpTools
        ? await getMcpToolsMessage(actorName, apifyClient, apifyToken, apifyMcpServer?.options.paymentProvider, mcpSessionId)
        : undefined;

    // NOTE: Data duplication between texts and structuredContent is intentional and required.
    // Some MCP clients only read text content, while others only read structured content.
    const { texts, structuredContent } = buildActorDetailsTextResponse({
        details,
        output: resolvedOutput,
        actorOutputSchema,
        mcpToolsMessage,
    });

    return buildMCPResponse({ texts, structuredContent });
}
