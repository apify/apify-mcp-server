import { z } from 'zod';

import { ApifyClient } from '../apify-client.js';
import { HelperTools, TOOL_STATUS } from '../const.js';
import { connectMCPClient } from '../mcp/client.js';
import type { ActorsMcpServer } from '../mcp/server.js';
import type { ActorCardOptions, InternalToolArgs, ToolEntry, ToolInputSchema } from '../types.js';
import { getActorMcpUrlCached } from '../utils/actor.js';
import { fetchActorDetails } from '../utils/actor-details.js';
import { compileSchema } from '../utils/ajv.js';
import { buildMCPResponse } from '../utils/mcp.js';
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
    output: z.array(z.enum(['description', 'stats', 'pricing', 'rating', 'metadata', 'input-schema', 'readme', 'mcp-tools']))
        .min(1)
        .optional()
        .default(['description', 'stats', 'pricing', 'rating', 'metadata', 'readme', 'input-schema'])
        .describe(`Specify which information to include in the response. Options:
- 'description': Actor description text only
- 'stats': Usage statistics (users, runs, success rate)
- 'pricing': Pricing model and costs
- 'rating': User rating (out of 5 stars)
- 'metadata': Developer, categories, last modified date, and deprecation status
- 'input-schema': Required input parameters schema
- 'readme': Full README documentation
- 'mcp-tools': List of available tools (only for MCP server Actors)

Default: ['description', 'stats', 'pricing', 'rating', 'metadata', 'readme', 'input-schema']. Use specific options to save tokens.`),
});

export const fetchActorDetailsTool: ToolEntry = {
    type: 'internal',
    name: HelperTools.ACTOR_GET_DETAILS,
    description: `Get detailed information about an Actor by its ID or full name (format: "username/name", e.g., "apify/rag-web-browser").

Use the 'output' parameter to control which information is returned:
- Default: Returns all available info (description, stats, pricing, rating, metadata, README, and input schema)
- Minimal: Use output=['input-schema'] for token-efficient schema retrieval
- Description Only: Use output=['description'] to get just the Actor's description text
- Pricing Only: Use output=['pricing'] to get only pricing information
- Metadata: Use output=['metadata'] to get developer, categories, and dates
- MCP Tools: Use output=['mcp-tools'] to list available tools for MCP server Actors

USAGE:
- Use when a user asks about an Actor's details, input schema, README, or how to use it
- Use output=['description'] when user asks "what does this Actor do?"
- Use output=['input-schema'] before calling an Actor to get required parameters
- Use output=['pricing'] when user asks specifically about Actor costs
- Use output=['rating'] when user asks about Actor quality or reviews
- Use output=['metadata'] when user asks about developer or categories
- Use output=['mcp-tools'] to discover tools exposed by MCP server Actors

USAGE EXAMPLES:
- user_input: What does apify/rag-web-browser do?
- user_input: How to use apify/rag-web-browser
- user_input: What is the input schema for apify/rag-web-browser?
- user_input: What tools does apify/actors-mcp-server provide?
- user_input: What is the pricing for apify/instagram-scraper?
- user_input: Who developed apify/web-scraper?`,
    inputSchema: z.toJSONSchema(fetchActorDetailsToolArgsSchema) as ToolInputSchema,
    outputSchema: actorDetailsOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(fetchActorDetailsToolArgsSchema)),
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
            includeDescription: parsed.output.includes('description'),
            includeStats: parsed.output.includes('stats'),
            includePricing: parsed.output.includes('pricing'),
            includeRating: parsed.output.includes('rating'),
            includeMetadata: parsed.output.includes('metadata'),
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

        const actorUrl = `https://apify.com/${details.actorInfo.username}/${details.actorInfo.name}`;
        // Add link to README title
        details.readme = details.readme.replace(/^# /, `# [README](${actorUrl}/readme): `);

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
        if (parsed.output.includes('readme')) {
            texts.push(`${details.readme}`);
        }

        // Add input schema if requested
        if (parsed.output.includes('input-schema')) {
            texts.push(`# [Input schema](${actorUrl}/input)\n\`\`\`json\n${JSON.stringify(details.inputSchema)}\n\`\`\``);
        }

        // Handle MCP tools
        if (parsed.output.includes('mcp-tools')) {
            const message = await getMcpToolsMessage(parsed.actor, apifyClient, apifyToken, apifyMcpServer);
            texts.push(message);
        }

        // Update structured output
        const structuredContent: Record<string, unknown> = {
            actorInfo: needsCard ? details.actorCardStructured : undefined,
            readme: parsed.output.includes('readme') ? details.readme : undefined,
            inputSchema: parsed.output.includes('input-schema') ? details.inputSchema : undefined,
        };

        return buildMCPResponse({ texts, structuredContent });
    },
} as const;
