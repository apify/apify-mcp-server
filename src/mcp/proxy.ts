import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { fixedAjvCompile } from '../tools/utils.js';
import type { ActorMcpTool, ToolEntry } from '../types.js';
import { ajv } from '../utils/ajv.js';
import { getMCPServerID, getProxyMCPServerToolName } from './utils.js';

export async function getMCPServerTools(
    actorID: string,
    client: Client,
    serverUrl: string,
): Promise<ToolEntry[]> {
    const { tools } = await client.listTools();

    return tools.map((tool): ActorMcpTool => ({
        type: 'actor-mcp',
        actorId: actorID,
        serverId: getMCPServerID(serverUrl),
        serverUrl,
        originToolName: tool.name,
        name: getProxyMCPServerToolName(serverUrl, tool.name),
        description: tool.description || '',
        inputSchema: tool.inputSchema,
        ajvValidate: fixedAjvCompile(ajv, tool.inputSchema),
        annotations: tool.annotations,
    }));
}
