import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import dedent from 'dedent';
import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import { EXTERNAL_TOOL_CALL_TIMEOUT_MSEC } from '../../mcp/const.js';
import type { InternalToolArgs, ToolDescriptionContext, ToolEntry, ToolInputSchema } from '../../types.js';
import { ALL_TOOLS_PRESENT, TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import type { ToolResponse } from '../../utils/mcp.js';
import { respondOk } from '../../utils/mcp.js';
import { actorMcpToolListOutputSchema } from '../structured_output_schemas.js';
import { runOnActorMcpServer } from './call_actor_mcp_tool.js';

/** The remote server is third-party code; a cursor that never runs out must not keep the listing going. */
const MAX_TOOL_LIST_PAGES = 100;

const fetchActorMcpToolListArgs = z.object({
    actor: z.string().min(1).describe('The MCP server Actor: its ID, or its name in the "username/name" form.'),
});

function buildDescription({ hasTool }: ToolDescriptionContext): string {
    const callTool = hasTool(HELPER_TOOLS.ACTOR_MCP_TOOL_CALL)
        ? ` ${HELPER_TOOLS.ACTOR_MCP_TOOL_CALL} calls one of them by name.`
        : '';
    return dedent`
        List the tools on the MCP server of an Actor that is an MCP server: each tool's name, description, input schema, annotations and metadata, as the server reports them.${callTool}
        Each call asks the server again; nothing is cached. The server connects with the Apify API token. Connecting can start a standby run of the Actor in your account, kept for its idle timeout, or is charged per event when the Actor is multi-tenant.

        USAGE:
        - Use when the user asks which tools an Actor that is an MCP server provides, or before calling one of them.

        USAGE EXAMPLES:
        - user_input: What tools does username/name provide?
    `;
}

/** Every page of `tools/list`, following `nextCursor`; a failed page fails the listing. */
async function fetchAllTools(client: Client, signal: AbortSignal): Promise<Tool[]> {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_LIST_PAGES; page++) {
        const result = await client.listTools(cursor === undefined ? undefined : { cursor }, {
            timeout: EXTERNAL_TOOL_CALL_TIMEOUT_MSEC,
            signal,
        });
        tools.push(...result.tools);
        cursor = result.nextCursor;
        if (cursor === undefined) return tools;
    }
    throw new Error(`the server returned more than ${MAX_TOOL_LIST_PAGES} pages`);
}

function buildToolListResponse(tools: Tool[]): ToolResponse {
    const count = `The Actor's MCP server has ${tools.length} ${tools.length === 1 ? 'tool' : 'tools'}.`;
    const texts = tools.map(
        (tool) =>
            `${tool.name}: ${tool.description ?? 'No description.'}\nInput schema: ${JSON.stringify(tool.inputSchema)}`,
    );
    return respondOk([count, ...texts], { structuredContent: { tools } });
}

export async function executeFetchActorMcpToolList(toolArgs: InternalToolArgs): Promise<ToolResponse> {
    const { actor } = fetchActorMcpToolListArgs.parse(toolArgs.args);
    return runOnActorMcpServer(toolArgs, {
        actor,
        operation: 'list the MCP tools',
        run: async (client) => buildToolListResponse(await fetchAllTools(client, toolArgs.signal)),
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
        idempotentHint: true,
        // It lists tools and calls none.
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => executeFetchActorMcpToolList(toolArgs),
} as const);
