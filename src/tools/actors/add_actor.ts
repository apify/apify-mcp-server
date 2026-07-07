import { z } from 'zod';

import { ApifyClient } from '../../apify_client.js';
import { HELPER_TOOLS } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { respondOk, respondServerError } from '../../utils/mcp.js';

export const addToolArgsSchema = z.object({
    actor: z
        .string()
        .min(1)
        .describe(`Actor ID or full name in the format "username/name", e.g., "apify/rag-web-browser".`),
});
export const addActor: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_ADD,
    title: 'Add tool',
    description: `Add an Actor or MCP server to the Apify MCP Server as an available tool.
This does not execute the Actor; it only registers it so it can be called later.

You can first discover Actors using the ${HELPER_TOOLS.STORE_SEARCH} tool, then add the selected Actor as a tool.

USAGE:
- Use when a user has chosen an Actor to work with and you need to make it available as a callable tool.

USAGE EXAMPLES:
- user_input: Add apify/rag-web-browser as a tool
- user_input: Add apify/instagram-scraper as a tool`,
    inputSchema: z.toJSONSchema(addToolArgsSchema) as ToolInputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(addToolArgsSchema)),
    annotations: {
        title: 'Add tool',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
    },
    // TODO: I don't like that we are passing apifyMcpServer and mcpServer to the tool
    call: async (toolArgs: InternalToolArgs) => {
        const {
            apifyMcpServer,
            apifyToken,
            args,
            extra: { sendNotification },
        } = toolArgs;
        const parsed = addToolArgsSchema.parse(args);
        if (apifyMcpServer.listAllToolNames().includes(parsed.actor)) {
            return respondOk(`Actor ${parsed.actor} is already available. No new tools were added.`);
        }

        const apifyClient = new ApifyClient({ token: apifyToken });
        const { tools, errors } = await apifyMcpServer.loadActorsAsTools([parsed.actor], apifyClient);
        // First error is the precise reason this Actor could not be added —
        // safe to forward verbatim (sanitized at source by ActorLoadError factories).
        if (errors[0]) {
            return respondServerError(errors[0].message);
        }
        await sendNotification({ method: 'notifications/tools/list_changed' });
        const toolNames = tools.map((t: ToolEntry) => t.name).join(', ');
        // Many MCP clients ignore `notifications/tools/list_changed`, so nudge the LLM to
        // re-list tools itself — otherwise the freshly added Actor stays invisible until the
        // client happens to refresh (apify-mcp-server#851).
        return respondOk(
            `Actor ${parsed.actor} has been added. Newly available tools: ${toolNames}. ` +
                `If they are not visible yet, refresh the tool list using the tools/list request before calling them.`,
        );
    },
} as const);
