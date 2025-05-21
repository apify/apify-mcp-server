import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import Ajv from 'ajv';

import type { ActorMcpTool, ToolEntry } from '../types.js';
import { getMCPServerID, getProxyMCPServerToolName } from './utils.js';

export async function getMCPServerTools(
    actorID: string,
    client: Client,
    // Name of the MCP server
    serverUrl: string,
): Promise<ToolEntry[]> {
    const res = await client.listTools();
    const { tools } = res;

    const ajv = new Ajv({ coerceTypes: 'array', strict: false });

    const compiledTools: ToolEntry[] = [];
    for (const tool of tools) {
        const mcpTool: ActorMcpTool = {
            actorId: actorID,
            serverId: getMCPServerID(serverUrl),
            serverUrl,
            originToolName: tool.name,

            name: getProxyMCPServerToolName(serverUrl, tool.name),
            description: tool.description || '',
            inputSchema: tool.inputSchema,
            ajvValidate: ajv.compile(tool.inputSchema),
        };

        const wrap: ToolEntry = {
            type: 'actor-mcp',
            tool: mcpTool,
        };

        compiledTools.push(wrap);
    }

    return compiledTools;
}
