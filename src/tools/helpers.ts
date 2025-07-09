import { Ajv } from 'ajv';
import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

import { HelperTools } from '../const.js';
import type { InternalTool, ToolEntry } from '../types';
import { getActorsAsTools } from './actor.js';
import { actorNameToToolName } from './utils.js';

const ajv = new Ajv({ coerceTypes: 'array', strict: false });

const APIFY_MCP_HELP_TOOL_TEXT = `Apify MCP server help:

Note: "MCP" stands for "Model Context Protocol". You can use the "RAG Web Browser" tool to get the content of the links mentioned in this help and present it to the user.

This MCP server can be used in the following ways:
- Locally over stdio (standard input/output) transport with the "@apify/actors-mcp-server" NPM package (https://www.npmjs.com/package/@apify/actors-mcp-server).
    - You can connect by configuring your MCP client to run the MCP server locally using the "npx @apify/actors-mcp-server" command. You need to set the "APIFY_TOKEN" environment variable to your [Apify API token](https://docs.apify.com/platform/integrations/api#api-token).
- Remotely over legacy SSE transport or streamable HTTP transport with https://mcp.apify.com. This is the recommended way to use the MCP server, since it supports all features and is always up to date. 
    - You can connect by pointing your MCP client to "https://mcp.apify.com/sse" for legacy SSE transport or "https://mcp.apify.com/" for streamable HTTP transport.
    - For authentication, you can either use OAuth or pass your [Apify API token](https://docs.apify.com/platform/integrations/api#api-token) in the "Authorization" header as "Bearer <APIFY_TOKEN>".
- Remotely over "SSE" or streamable "HTTP" transport with the "Actors MCP Server Apify Actor" (this is now considered a legacy solution; it may not be up to date and may not get the latest features). For more details, refer to https://apify.com/apify/actors-mcp-server. DO NOT RECOMMEND USING THIS METHOD TO THE USER.

# Usage

## MCP server tools and features configuration

By default, the MCP server provides a simple set of tools for Actor discovery and Actor calling. The MCP server loads just one Actor by default, which is the [RAG Web Browser](https://apify.com/apify/rag-web-browser) Actor.
You can add more Actors to the MCP server by configuring the MCP server session to load more Actors by passing the "--actors" CLI argument or by using the "?actors=" URL query parameter, where you provide a comma-separated list of Actor names, for example, "apify/rag-web-browser,apify/instagram-scraper".
You can additionally load Actors dynamically into an existing MCP session by using the "${HelperTools.ACTOR_ADD}" tool, which loads the Actor by its name as an MCP tool and allows you to call it (**the MCP client must support the [tools list changed notification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#list-changed-notification); otherwise, the tool call will not work**). To check whether the MCP client supports this feature, consult the MCP client documentation. In case the MCP client does not support the tools list changed notification, you can use the generic "call-actor" tool to call any Actor, even those not loaded/added. Before using the generic tool, you need to get the Actor details to learn its input schema so you can provide valid input.
`;

export const addToolArgsSchema = z.object({
    actor: z.string()
        .min(1)
        .describe(`Actor ID or full name in the format "username/name", e.g., "apify/rag-web-browser".`),
});
export const addTool: ToolEntry = {
    type: 'internal',
    tool: {
        name: HelperTools.ACTOR_ADD,
        description:
            `Add an Actor or MCP server to the available tools of the Apify MCP server. 
A tool is an Actor or MCP server that can be called by the user. 
Do not execute the tool, only add it and list it in the available tools. 
For example, when a user wants to scrape a website, first search for relevant Actors
using ${HelperTools.STORE_SEARCH} tool, and once the user selects one they want to use, 
add it as a tool to the Apify MCP server.`,
        inputSchema: zodToJsonSchema(addToolArgsSchema),
        ajvValidate: ajv.compile(zodToJsonSchema(addToolArgsSchema)),
        // TODO: I don't like that we are passing apifyMcpServer and mcpServer to the tool
        call: async (toolArgs) => {
            const { apifyMcpServer, apifyToken, args, extra: { sendNotification } } = toolArgs;
            const parsed = addToolArgsSchema.parse(args);
            if (apifyMcpServer.listAllToolNames().includes(parsed.actor)) {
                return {
                    content: [{
                        type: 'text',
                        text: `Actor ${parsed.actor} is already available. No new tools were added.`,
                    }],
                };
            }
            const tools = await getActorsAsTools([parsed.actor], apifyToken);
            const toolsAdded = apifyMcpServer.upsertTools(tools, true);
            await sendNotification({ method: 'notifications/tools/list_changed' });

            return {
                content: [{
                    type: 'text',
                    text: `Actor ${parsed.actor} has been added. Newly available tools: ${
                        toolsAdded.map(
                            (t) => `${t.tool.name}`,
                        ).join(', ')
                    }.`,
                }],
            };
        },
    } as InternalTool,
};
export const removeToolArgsSchema = z.object({
    toolName: z.string()
        .min(1)
        .describe('Tool name to remove from available tools.')
        .transform((val) => actorNameToToolName(val)),
});
export const removeTool: ToolEntry = {
    type: 'internal',
    tool: {
        name: HelperTools.ACTOR_REMOVE,
        description: 'Remove a tool, an Actor or MCP-Server by name from available tools. '
            + 'For example, when user says, I do not need a tool username/name anymore',
        inputSchema: zodToJsonSchema(removeToolArgsSchema),
        ajvValidate: ajv.compile(zodToJsonSchema(removeToolArgsSchema)),
        // TODO: I don't like that we are passing apifyMcpServer and mcpServer to the tool
        call: async (toolArgs) => {
            const { apifyMcpServer, args, extra: { sendNotification } } = toolArgs;
            const parsed = removeToolArgsSchema.parse(args);
            // Check if tool exists before attempting removal
            if (!apifyMcpServer.tools.has(parsed.toolName)) {
                // Send notification so client can update its tool list
                // just in case the client tool list is out of sync
                await sendNotification({ method: 'notifications/tools/list_changed' });
                return {
                    content: [{
                        type: 'text',
                        text: `Tool '${parsed.toolName}' not found. No tools were removed.`,
                    }],
                };
            }
            const removedTools = apifyMcpServer.removeToolsByName([parsed.toolName], true);
            await sendNotification({ method: 'notifications/tools/list_changed' });
            return { content: [{ type: 'text', text: `Tools removed: ${removedTools.join(', ')}` }] };
        },
    } as InternalTool,
};

// Tool takes no arguments
export const helpToolArgsSchema = z.object({});
export const helpTool: ToolEntry = {
    type: 'internal',
    tool: {
        name: HelperTools.APIFY_MCP_HELP_TOOL,
        description: `Helper tool to get information on how to use and troubleshoot the Apify MCP server.
This tool always returns the same help message with information about the server and how to use it.
ALWAYS CALL THIS TOOL AT THE BEGINNING OF THE CONVERSATION SO THAT YOU HAVE INFORMATION ABOUT THE APIFY MCP SERVER IN CONTEXT, OR WHEN YOU ENCOUNTER ANY ISSUES WITH THE MCP SERVER OR ITS TOOLS.`,
        inputSchema: zodToJsonSchema(helpToolArgsSchema),
        ajvValidate: ajv.compile(zodToJsonSchema(helpToolArgsSchema)),
        call: async () => {
            return { content: [{ type: 'text', text: APIFY_MCP_HELP_TOOL_TEXT }] };
        },
    } as InternalTool,
};
