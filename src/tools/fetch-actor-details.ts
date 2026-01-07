import { z } from 'zod';

import { ApifyClient } from '../apify-client.js';
import { HelperTools, TOOL_STATUS } from '../const.js';
import { connectMCPClient } from '../mcp/client.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../types.js';
import { getActorMcpUrlCached } from '../utils/actor.js';
import { fetchActorDetails } from '../utils/actor-details.js';
import { compileSchema } from '../utils/ajv.js';
import { buildMCPResponse } from '../utils/mcp.js';
import { actorDetailsOutputSchema } from './structured-output-schemas.js';

const fetchActorDetailsToolArgsSchema = z.object({
    actor: z.string()
        .min(1)
        .describe(`Actor ID or full name in the format "username/name", e.g., "apify/rag-web-browser".`),
    output: z.array(z.enum(['description', 'stats', 'pricing', 'input-schema', 'readme', 'mcp-tools']))
        .min(1)
        .optional()
        .default(['description', 'stats', 'pricing', 'readme', 'input-schema'])
        .describe(`Specify which information to include in the response. Options:
- 'description': Actor title, description, and basic info
- 'stats': Usage statistics and ratings
- 'pricing': Pricing model and costs
- 'input-schema': Required input parameters schema
- 'readme': Full README documentation
- 'mcp-tools': List of available tools (only for MCP server Actors)

Default: ['description', 'stats', 'pricing', 'readme', 'input-schema']. Use specific options to save tokens.`),
});

export const fetchActorDetailsTool: ToolEntry = {
    type: 'internal',
    name: HelperTools.ACTOR_GET_DETAILS,
    description: `Get detailed information about an Actor by its ID or full name (format: "username/name", e.g., "apify/rag-web-browser").

Use the 'output' parameter to control which information is returned:
- Default: Returns description, stats, pricing, README, and input schema (comprehensive)
- Minimal: Use output=['input-schema'] for token-efficient schema retrieval
- MCP Tools: Use output=['mcp-tools'] to list available tools for MCP server Actors

USAGE:
- Use when a user asks about an Actor's details, input schema, README, or how to use it
- Use output=['input-schema'] before calling an Actor to get required parameters
- Use output=['mcp-tools'] to discover tools exposed by MCP server Actors

USAGE EXAMPLES:
- user_input: How to use apify/rag-web-browser
- user_input: What is the input schema for apify/rag-web-browser?
- user_input: What tools does apify/actors-mcp-server provide?
- user_input: What is the pricing for apify/instagram-scraper?`,
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
        const details = await fetchActorDetails(apifyClient, parsed.actor);
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
        // Build actor card only if description/stats/pricing requested
        const needsCard = parsed.output.some((o) => ['description', 'stats', 'pricing'].includes(o));
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
            const mcpServerUrl = await getActorMcpUrlCached(parsed.actor, apifyClient);
            if (mcpServerUrl && typeof mcpServerUrl === 'string') {
                // Check Skyfire mode restriction
                if (apifyMcpServer.options.skyfireMode) {
                    texts.push(`This Actor is an MCP server and cannot be accessed in Skyfire mode.`);
                } else {
                    // Connect and list tools
                    const client = await connectMCPClient(mcpServerUrl, apifyToken);
                    if (!client) {
                        texts.push(`Failed to connect to MCP server for Actor '${parsed.actor}'.`);
                    } else {
                        try {
                            const toolsResponse = await client.listTools();

                            const mcpToolsInfo = toolsResponse.tools.map((tool) => `**${tool.name}**\n${tool.description || 'No description'}\nInput schema:\n\`\`\`json\n${JSON.stringify(tool.inputSchema)}\n\`\`\``,
                            ).join('\n\n');

                            texts.push(`# Available MCP Tools\nThis Actor is an MCP server with ${toolsResponse.tools.length} tools.\nTo call a tool, use: "${parsed.actor}:{toolName}"\n\n${mcpToolsInfo}`);
                        } finally {
                            await client.close();
                        }
                    }
                }
            } else {
                // Not an MCP server - graceful handling
                texts.push(`Note: This Actor is not an MCP server and does not expose MCP tools.`);
            }
        }

        // Update structured output
        const structuredContent: Record<string, unknown> = {
            actorInfo: parsed.output.some((o) => ['description', 'stats', 'pricing'].includes(o))
                ? details.actorCardStructured
                : undefined,
            readme: parsed.output.includes('readme') ? details.readme : undefined,
            inputSchema: parsed.output.includes('input-schema') ? details.inputSchema : undefined,
        };

        return buildMCPResponse({ texts, structuredContent });
    },
} as const;
