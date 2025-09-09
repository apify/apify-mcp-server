import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

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
        description: `Add an Actor or MCP server to the available tools of the Apify MCP server.\n`
            + 'A tool is an Actor or MCP server that can be called by the user.\n'
            + 'Do not execute the tool, only add it and list it in the available tools.\n'
            + 'For example, when a user wants to scrape a website, first search for relevant Actors\n'
            + `using ${HelperTools.STORE_SEARCH} tool, and once the user selects one they want to use,\n`
            + 'add it as a tool to the Apify MCP server.',
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

            const tools = await apifyMcpServer.loadActorsAsTools([parsed.actor], apifyToken);
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
