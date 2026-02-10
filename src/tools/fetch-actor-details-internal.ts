import { z } from 'zod';

import { ApifyClient } from '../apify-client.js';
import { HelperTools } from '../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../types.js';
import {
    actorDetailsOutputOptionsSchema,
    buildActorDetailsTextResponse,
    buildActorNotFoundResponse,
    buildCardOptions,
    fetchActorDetails,
    resolveOutputOptions,
} from '../utils/actor-details.js';
import { compileSchema } from '../utils/ajv.js';
import { buildMCPResponse } from '../utils/mcp.js';
import { actorDetailsOutputSchema } from './structured-output-schemas.js';

const fetchActorDetailsInternalArgsSchema = z.object({
    actor: z.string()
        .min(1)
        .describe(`Actor ID or full name in the format "username/name", e.g., "apify/rag-web-browser".`),
    output: actorDetailsOutputOptionsSchema.optional()
        .describe('Specify which information to include in the response to save tokens.'),
});

export const fetchActorDetailsInternalTool: ToolEntry = {
    type: 'internal',
    name: HelperTools.ACTOR_GET_DETAILS_INTERNAL,
    openaiOnly: true,
    description: `Fetch Actor details with flexible output options (UI mode internal tool).

This tool is available because the LLM is operating in UI mode. Use it for internal lookups
where data presentation to the user is NOT needed - this tool does NOT render a widget.

Use 'output' parameter with boolean flags to control returned information:
- Default: Fields: description, stats, pricing, rating, metadata, inputSchema, readme - excepts McpTools
- Selective: Set desired fields to true to save tokens (e.g., output: { inputSchema: true, readme: false })
- Common patterns: inputSchema only for execution prep, readme + inputSchema for documentation, etc.

Use this instead of fetch-actor-details when you need Actor information to prepare execution
but the user did NOT explicitly ask for Actor details presentation.`,
    inputSchema: z.toJSONSchema(fetchActorDetailsInternalArgsSchema) as ToolInputSchema,
    outputSchema: actorDetailsOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(fetchActorDetailsInternalArgsSchema)),
    annotations: {
        title: 'Fetch Actor details internal',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyToken, apifyMcpServer, mcpSessionId } = toolArgs;
        const parsed = fetchActorDetailsInternalArgsSchema.parse(args);
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

        const { texts, structuredContent } = await buildActorDetailsTextResponse({
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

        return buildMCPResponse({ texts, structuredContent });
    },
} as const;
