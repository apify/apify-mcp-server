import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

import { ApifyClient } from '../apify-client.js';
import { HelperTools } from '../const.js';
import type { InternalTool, ToolEntry } from '../types.js';
import { ajv } from '../utils/ajv.js';

export const addToolArgsSchema = z.object({
    actor: z.string()
        .min(1)
        .describe(`Actor ID or full name in the format "username/name", e.g., "apify/rag-web-browser".`),
});
export const addTool: ToolEntry = {
    type: 'internal',
    tool: {
        name: HelperTools.ACTOR_ADD,
        description: `Add an Actor or MCP server to the Apify MCP Server as an available tool.
This does not execute the Actor; it only registers it so it can be called later.

You can first discover Actors using the ${HelperTools.STORE_SEARCH} tool, then add the selected Actor as a tool.

USAGE:
- Use when a user has chosen an Actor to work with and you need to make it available as a callable tool.

EXAMPLES:
- user_input: Add apify/rag-web-browser as a tool
- user_input: Add apify/instagram-scraper as a tool`,
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

            const apifyClient = new ApifyClient({ token: apifyToken });
            const tools = await apifyMcpServer.loadActorsAsTools([parsed.actor], apifyClient);
            /**
             * If no tools were found, return a message that the Actor was not found
             * instead of returning that non existent tool was added since the
             * loadActorsAsTools method returns an empty array and does not throw an error.
             */
            if (tools.length === 0) {
                return {
                    content: [{
                        type: 'text',
                        text: `Actor ${parsed.actor} not found, no tools were added.`,
                    }],
                };
            }

            await sendNotification({ method: 'notifications/tools/list_changed' });

            return {
                content: [{
                    type: 'text',
                    text: `Actor ${parsed.actor} has been added. Newly available tools: ${
                        tools.map(
                            (t) => `${t.tool.name}`,
                        ).join(', ')
                    }.`,
                }],
            };
        },
    } as InternalTool,
};
