import { z } from 'zod';

import { ApifyClient } from '../apify-client.js';
import { HelperTools, TOOL_STATUS } from '../const.js';
import { connectMCPClient } from '../mcp/client.js';
import type { ActorsMcpServer } from '../mcp/server.js';
import type { ActorCardOptions, InternalToolArgs, ToolEntry, ToolInputSchema } from '../types.js';
import { getActorMcpUrlCached } from '../utils/actor.js';
import { fetchActorDetails, processActorDetailsForResponse } from '../utils/actor-details.js';
import { compileSchema } from '../utils/ajv.js';
import { buildMCPResponse } from '../utils/mcp.js';
import { getWidgetConfig, WIDGET_URIS } from '../utils/widgets.js';
import { actorDetailsOutputSchema } from './structured-output-schemas.js';

/**
 * Gets MCP tools information for an Actor.
 * Returns a message about available tools, error, or that the Actor is not an MCP server.
 */
async function getMcpToolsMessage(
    actorName: string,
    apifyClient: ApifyClient,
    apifyToken: string,
    apifyMcpServer: ActorsMcpServer,
): Promise<string> {
    const mcpServerUrl = await getActorMcpUrlCached(actorName, apifyClient);

    // Early return: not an MCP server
    if (!mcpServerUrl || typeof mcpServerUrl !== 'string') {
        return `Note: This Actor is not an MCP server and does not expose MCP tools.`;
    }

    // Early return: Skyfire mode restriction
    if (apifyMcpServer.options.skyfireMode) {
        return `This Actor is an MCP server and cannot be accessed in Skyfire mode.`;
    }

    // Connect and list tools
    const client = await connectMCPClient(mcpServerUrl, apifyToken);
    if (!client) {
        return `Failed to connect to MCP server for Actor '${actorName}'.`;
    }

    try {
        const toolsResponse = await client.listTools();
        const mcpToolsInfo = toolsResponse.tools
            .map((tool) => `**${tool.name}**\n${tool.description || 'No description'}\nInput schema:\n\`\`\`json\n${JSON.stringify(tool.inputSchema)}\n\`\`\``)
            .join('\n\n');

        return `# Available MCP Tools\nThis Actor is an MCP server with ${toolsResponse.tools.length} tools.\nTo call a tool, use: "${actorName}:{toolName}"\n\n${mcpToolsInfo}`;
    } finally {
        await client.close();
    }
}

const fetchActorDetailsToolArgsSchema = z.object({
    actor: z.string()
        .min(1)
        .describe(`Actor ID or full name in the format "username/name", e.g., "apify/rag-web-browser".`),
    output: z.object({
        description: z.boolean().default(true).describe('Include Actor description text only.'),
        stats: z.boolean().default(true).describe('Include usage statistics (users, runs, success rate).'),
        pricing: z.boolean().default(true).describe('Include pricing model and costs.'),
        rating: z.boolean().default(true).describe('Include user rating (out of 5 stars).'),
        metadata: z.boolean().default(true).describe('Include developer, categories, last modified date, and deprecation status.'),
        inputSchema: z.boolean().default(true).describe('Include required input parameters schema.'),
        readme: z.boolean().default(true).describe('Include full README documentation.'),
        mcpTools: z.boolean().default(false).describe('List available tools (only for MCP server Actors).'),
    })
        .optional()
        .default({
            description: true,
            stats: true,
            pricing: true,
            rating: true,
            metadata: true,
            inputSchema: true,
            readme: true,
            mcpTools: false,
        })
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
        const { args, apifyToken, apifyMcpServer } = toolArgs;
        const parsed = fetchActorDetailsToolArgsSchema.parse(args);
        const apifyClient = new ApifyClient({ token: apifyToken });

        // Build granular card options based on requested output
        const cardOptions: ActorCardOptions = {
            includeDescription: parsed.output.description,
            includeStats: parsed.output.stats,
            includePricing: parsed.output.pricing,
            includeRating: parsed.output.rating,
            includeMetadata: parsed.output.metadata,
        };

        const details = await fetchActorDetails(apifyClient, parsed.actor, cardOptions);
        if (!details) {
            return buildMCPResponse({
                texts: [`Actor information for '${parsed.actor}' was not found.
Please verify Actor ID or name format and ensure that the Actor exists.
You can search for available Actors using the tool: ${HelperTools.STORE_SEARCH}.`],
                isError: true,
                toolStatus: TOOL_STATUS.SOFT_FAIL,
            });
        }

        const { structuredContent: processedStructuredContent, formattedReadme, actorUrl } = processActorDetailsForResponse(details);

        const structuredContent = {
            actorInfo: details.actorCardStructured,
            readme: formattedReadme,
            inputSchema: details.inputSchema,
        };

        if (apifyMcpServer.options.uiMode === 'openai') {
            const widgetStructuredContent = {
                ...structuredContent,
                actorDetails: processedStructuredContent.actorDetails,
            };

            const texts = [`
# Actor information:
- **Actor:** ${parsed.actor}
- **URL:** ${actorUrl}

View the interactive widget below for detailed Actor information.
`];

            const widgetConfig = getWidgetConfig(WIDGET_URIS.SEARCH_ACTORS);
            return buildMCPResponse({
                texts,
                structuredContent: widgetStructuredContent,
                _meta: {
                    ...widgetConfig?.meta,
                    'openai/widgetDescription': `Actor details for ${parsed.actor} from Apify Store`,
                },
            });
        }

        const texts: string[] = [];

        // NOTE: Data duplication between texts and structuredContent is intentional and required.
        // Some MCP clients only read text content, while others only read structured content.
        // Build actor card only if any card section is requested
        const needsCard = cardOptions.includeDescription
            || cardOptions.includeStats
            || cardOptions.includePricing
            || cardOptions.includeRating
            || cardOptions.includeMetadata;

        if (needsCard) {
            texts.push(`# Actor information\n${details.actorCard}`);
        }

        // Add README if requested
        if (parsed.output.readme) {
            texts.push(formattedReadme);
        }

        // Add input schema if requested
        if (parsed.output.inputSchema) {
            texts.push(`# [Input schema](${actorUrl}/input)\n\`\`\`json\n${JSON.stringify(details.inputSchema)}\n\`\`\``);
        }

        // Handle MCP tools
        if (parsed.output.mcpTools) {
            const message = await getMcpToolsMessage(parsed.actor, apifyClient, apifyToken, apifyMcpServer);
            texts.push(message);
        }

        // Update structured output
        const responseStructuredContent: Record<string, unknown> = {
            actorInfo: needsCard ? details.actorCardStructured : undefined,
            readme: parsed.output.readme ? formattedReadme : undefined,
            inputSchema: parsed.output.inputSchema ? details.inputSchema : undefined,
        };

        return buildMCPResponse({ texts, structuredContent: responseStructuredContent });
    },
} as const;
