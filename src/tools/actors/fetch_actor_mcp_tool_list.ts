import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import dedent from 'dedent';
import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import { EXTERNAL_TOOL_CALL_TIMEOUT_MSEC } from '../../mcp/const.js';
import type { InternalToolArgs, ToolDescriptionContext, ToolEntry, ToolInputSchema } from '../../types.js';
import { ALL_TOOLS_PRESENT, TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import type { ToolResponse } from '../../utils/mcp.js';
import { respondOk, respondServerError } from '../../utils/mcp.js';
import { actorMcpToolListOutputSchema } from '../structured_output_schemas.js';
import { runOnActorMcpServer } from './call_actor_mcp_tool.js';

/** The remote server is third-party code; a cursor that never runs out must not keep the listing going. */
export const MAX_TOOL_LIST_PAGES = 100;

const fetchActorMcpToolListArgs = z.object({
    actor: z.string().min(1).describe('The MCP server Actor: its ID, or its name in the "username/name" form.'),
});

function buildDescription({ hasTool }: ToolDescriptionContext): string {
    const callTool = hasTool(HELPER_TOOLS.ACTOR_MCP_TOOL_CALL)
        ? ` ${HELPER_TOOLS.ACTOR_MCP_TOOL_CALL} calls one of them by name.`
        : '';
    return dedent`
        List an Actor's MCP tools with each tool's name, description, input schema, annotations, and metadata, as the server reports them.${callTool}
        Each call asks the server again; nothing is cached. The server connects with the Apify API token. Connecting can start a standby run of the Actor in your account, kept for its idle timeout, or is charged per event when the Actor is multi-tenant.

        USAGE:
        - Use when the user asks which MCP tools an Actor provides, or before calling one of them.

        USAGE EXAMPLES:
        - user_input: What tools does username/name provide?
    `;
}

function buildToolListResponse(tools: Tool[]): ToolResponse {
    const count = `The Actor's MCP server has ${tools.length} ${tools.length === 1 ? 'tool' : 'tools'}.`;
    const texts = tools.map(
        (tool) =>
            `${tool.name}: ${tool.description || 'No description.'}\nInput schema: ${JSON.stringify(tool.inputSchema)}`,
    );
    return respondOk([count, ...texts], { structuredContent: { tools } });
}

export async function executeFetchActorMcpToolList(toolArgs: InternalToolArgs): Promise<ToolResponse> {
    const { actor } = fetchActorMcpToolListArgs.parse(toolArgs.args);
    return runOnActorMcpServer(toolArgs, {
        actor,
        operation: 'list the MCP tools',
        // Follows `nextCursor`; a failed page fails the listing. Not `client.listTools`: it compiles every remote
        // output schema, so one that does not compile would fail the listing.
        run: async (client) => {
            const tools: Tool[] = [];
            let cursor: string | undefined;
            for (let page = 0; page < MAX_TOOL_LIST_PAGES; page++) {
                const result = await client.request(
                    { method: 'tools/list', params: cursor === undefined ? undefined : { cursor } },
                    ListToolsResultSchema,
                    { timeout: EXTERNAL_TOOL_CALL_TIMEOUT_MSEC, signal: toolArgs.signal },
                );
                tools.push(...result.tools);
                cursor = result.nextCursor;
                if (cursor === undefined) return buildToolListResponse(tools);
            }
            return respondServerError(
                `The Actor's MCP server returned more than ${MAX_TOOL_LIST_PAGES} pages of tools, so the listing stopped.`,
            );
        },
    });
}

/** Lists an MCP server Actor's tools with `tools/list`, uncached; discovery may wake the Actor. */
export const fetchActorMcpToolList: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_MCP_TOOL_LIST,
    title: 'Fetch Actor MCP tool list',
    description: buildDescription(ALL_TOOLS_PRESENT),
    buildDescription,
    inputSchema: z.toJSONSchema(fetchActorMcpToolListArgs) as ToolInputSchema,
    outputSchema: actorMcpToolListOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(fetchActorMcpToolListArgs)),
    // A third-party payment provider cannot pay for a standby run, so such a session is rejected before the call.
    hasPaymentProviderStandbyCheck: true,
    annotations: {
        title: 'Fetch Actor MCP tool list',
        // Listing can start a billed standby run.
        readOnlyHint: false,
        destructiveHint: false,
        // Each call can start or charge a standby run.
        idempotentHint: false,
        // It lists tools and calls none.
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => executeFetchActorMcpToolList(toolArgs),
} as const);
