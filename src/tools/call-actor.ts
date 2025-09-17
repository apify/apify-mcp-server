import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

import log from '@apify/log';

import { ApifyClient } from '../apify-client.js';
import {
    HelperTools,
    SKYFIRE_TOOL_INSTRUCTIONS,
} from '../const.js';
import { connectMCPClient } from '../mcp/client.js';
import type { ToolEntry } from '../types.js';
import { callActorGetDataset, getActorMcpUrlCached, getActorsAsTools } from '../utils/actor.js';
import { fetchActorDetails } from '../utils/actor-details.js';
import { buildActorResponseContent } from '../utils/actor-response.js';
import { ajv } from '../utils/ajv.js';
import { buildMCPResponse } from '../utils/mcp.js';
import { actorNameToToolName } from './utils.js';

const callActorArgs = z.object({
    actor: z.string()
        .describe('The name of the Actor to call. For example, "apify/rag-web-browser".'),
    step: z.enum(['info', 'call'])
        .default('info')
        .describe(`Step to perform: "info" to get Actor details and input schema (required first step), "call" to execute the Actor (only after getting info).`),
    input: z.object({}).passthrough()
        .optional()
        .describe(`The input JSON to pass to the Actor. For example, {"query": "apify", "maxResults": 5, "outputFormats": ["markdown"]}. Required only when step is "call".`),
    callOptions: z.object({
        memory: z.number()
            .min(128, 'Memory must be at least 128 MB')
            .max(32768, 'Memory cannot exceed 32 GB (32768 MB)')
            .optional()
            .describe(`Memory allocation for the Actor in MB. Must be a power of 2 (e.g., 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768). Minimum: 128 MB, Maximum: 32768 MB (32 GB).`),
        timeout: z.number()
            .min(0, 'Timeout must be 0 or greater')
            .optional()
            .describe(`Maximum runtime for the Actor in seconds. After this time elapses, the Actor will be automatically terminated. Use 0 for infinite timeout (no time limit). Minimum: 0 seconds (infinite).`),
    }).optional()
        .describe('Optional call options for the Actor run configuration.'),
});

export const callActor: ToolEntry = {
    type: 'internal',
    tool: {
        name: HelperTools.ACTOR_CALL,
        actorFullName: HelperTools.ACTOR_CALL,
        description: `Call Any Actor from Apify Store - Two-Step Process

This tool uses a mandatory two-step process to safely call any Actor from the Apify store.

USAGE:
• ONLY for Actors that are NOT available as dedicated tools
• If a dedicated tool exists (e.g., ${actorNameToToolName('apify/rag-web-browser')}), use that instead

MANDATORY TWO-STEP WORKFLOW:

Step 1: Get Actor Info (step="info", default)
• First call this tool with step="info" to get Actor details and input schema
• For regular Actors: returns the Actor input schema
• For MCP server Actors: returns list of available tools with their schemas
• You MUST do this step first - it's required to understand how to call the Actor

Step 2: Call Actor (step="call")
• Only after step 1, call again with step="call" and proper input based on the schema
• For regular Actors: executes the Actor and returns results
• For MCP server Actors: use format "actor-name:tool-name" to call specific tools

MCP SERVER ACTORS:
• For MCP server actors, step="info" lists available tools instead of input schema
• To call an MCP tool, use actor name format: "actor-name:tool-name" with step="call"
• Example: actor="apify/my-mcp-actor:search-tool", step="call", input={...}

The step parameter enforces this workflow - you cannot call an Actor without first getting its info.`,
        inputSchema: zodToJsonSchema(callActorArgs),
        ajvValidate: ajv.compile({
            ...zodToJsonSchema(callActorArgs),
            // Additional props true to allow skyfire-pay-id
            additionalProperties: true,
        }),
        call: async (toolArgs) => {
            const { args, apifyToken, progressTracker, extra, apifyMcpServer } = toolArgs;
            const { actor: actorName, step, input, callOptions } = callActorArgs.parse(args);

            // Parse special format: actor:tool
            const mcpToolMatch = actorName.match(/^(.+):(.+)$/);
            let baseActorName = actorName;
            let mcpToolName: string | undefined;

            if (mcpToolMatch) {
                baseActorName = mcpToolMatch[1];
                mcpToolName = mcpToolMatch[2];
            }

            // For definition resolution we always use token-based client; Skyfire is only for actual Actor runs
            const apifyClientForDefinition = new ApifyClient({ token: apifyToken });
            // Resolve MCP server URL
            const needsMcpUrl = mcpToolName !== undefined || step === 'info';
            const mcpServerUrlOrFalse = needsMcpUrl ? await getActorMcpUrlCached(baseActorName, apifyClientForDefinition) : false;
            const isActorMcpServer = mcpServerUrlOrFalse && typeof mcpServerUrlOrFalse === 'string';

            // Standby Actors, thus MCPs, are not supported in Skyfire mode
            if (isActorMcpServer && apifyMcpServer.options.skyfireMode) {
                return buildMCPResponse([`MCP server Actors are not supported in Skyfire mode. Please use a regular Apify token without Skyfire.`]);
            }

            try {
                if (step === 'info') {
                    if (isActorMcpServer) {
                        // MCP server: list tools
                        const mcpServerUrl = mcpServerUrlOrFalse;
                        let client: Client | undefined;
                        // Nested try to ensure client is closed
                        try {
                            client = await connectMCPClient(mcpServerUrl, apifyToken);
                            const toolsResponse = await client.listTools();

                            const toolsInfo = toolsResponse.tools.map((tool) => `**${tool.name}**\n${tool.description || 'No description'}\nInput Schema: ${JSON.stringify(tool.inputSchema, null, 2)}`,
                            ).join('\n\n');

                            return buildMCPResponse([`This is an MCP Server Actor with the following tools:\n\n${toolsInfo}\n\nTo call a tool, use step="call" with actor name format: "${baseActorName}:{toolName}"`]);
                        } finally {
                            if (client) await client.close();
                        }
                    } else {
                        // Regular actor: return schema
                        const details = await fetchActorDetails(apifyClientForDefinition, baseActorName);
                        if (!details) {
                            return buildMCPResponse([`Actor information for '${baseActorName}' was not found. Please check the Actor ID or name and ensure the Actor exists.`]);
                        }
                        const content = [
                            { type: 'text', text: `**Input Schema:**\n${JSON.stringify(details.inputSchema, null, 0)}` },
                        ];
                        /**
                         * Add Skyfire instructions also in the info step since clients are most likely truncating the long tool description of the call-actor.
                         */
                        if (apifyMcpServer.options.skyfireMode) {
                            content.push({
                                type: 'text',
                                text: SKYFIRE_TOOL_INSTRUCTIONS,
                            });
                        }
                        return { content };
                    }
                }

                /**
                 * In Skyfire mode, we check for the presence of `skyfire-pay-id`.
                 * If it is missing, we return instructions to the LLM on how to create it and pass it to the tool.
                 */
                if (apifyMcpServer.options.skyfireMode
                    && args['skyfire-pay-id'] === undefined
                ) {
                    return {
                        content: [{
                            type: 'text',
                            text: SKYFIRE_TOOL_INSTRUCTIONS,
                        }],
                    };
                }

                /**
                 * Create Apify token, for Skyfire mode use `skyfire-pay-id` and for normal mode use `apifyToken`.
                 */
                const apifyClient = apifyMcpServer.options.skyfireMode && typeof args['skyfire-pay-id'] === 'string'
                    ? new ApifyClient({ skyfirePayId: args['skyfire-pay-id'] })
                    : new ApifyClient({ token: apifyToken });

                // Step 2: Call the Actor
                if (!input) {
                    return buildMCPResponse([`Input is required when step="call". Please provide the input parameter based on the Actor's input schema.`]);
                }

                // Handle MCP tool calls
                if (mcpToolName) {
                    if (!isActorMcpServer) {
                        return buildMCPResponse([`Actor '${baseActorName}' is not an MCP server.`]);
                    }

                    const mcpServerUrl = mcpServerUrlOrFalse;
                    let client: Client | undefined;
                    try {
                        client = await connectMCPClient(mcpServerUrl, apifyToken);

                        const result = await client.callTool({
                            name: mcpToolName,
                            arguments: input,
                        });

                        return { content: result.content };
                    } finally {
                        if (client) await client.close();
                    }
                }

                // Handle regular Actor calls
                const [actor] = await getActorsAsTools([actorName], apifyClient);

                if (!actor) {
                    return buildMCPResponse([`Actor '${actorName}' was not found.`]);
                }

                if (!actor.tool.ajvValidate(input)) {
                    const { errors } = actor.tool.ajvValidate;
                    if (errors && errors.length > 0) {
                        return buildMCPResponse([
                            `Input validation failed for Actor '${actorName}': ${errors.map((e) => e.message).join(', ')}`,
                            `Input Schema:\n${JSON.stringify(actor.tool.inputSchema)}`,
                        ]);
                    }
                }

                const callResult = await callActorGetDataset(
                    actorName,
                    input,
                    apifyClient,
                    callOptions,
                    progressTracker,
                    extra.signal,
                );

                if (!callResult) {
                    // Receivers of cancellation notifications SHOULD NOT send a response for the cancelled request
                    // https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation#behavior-requirements
                    return { };
                }

                const content = buildActorResponseContent(actorName, callResult);

                return { content };
            } catch (error) {
                log.error('Failed to call Actor', { error, actorName, step });
                return buildMCPResponse([`Failed to call Actor '${actorName}': ${error instanceof Error ? error.message : String(error)}`]);
            }
        },
    },
};
