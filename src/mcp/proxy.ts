import { createHash } from 'node:crypto';

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { fixedAjvCompile } from '../tools/utils.js';
import type { ActorMcpTool, ToolEntry } from '../types.js';
import { ajv } from '../utils/ajv.js';
import { MAX_TOOL_NAME_LENGTH, SERVER_ID_LENGTH } from './const.js';

/**
 * Generates a unique server ID based on the provided URL.
 *
 * URL is used instead of Actor ID because one Actor may expose multiple servers - legacy SSE / streamable HTTP.
 *
 * @param url The URL to generate the server ID from.
 * @returns A unique server ID.
 */
export function getMCPServerID(url: string): string {
    const serverHashDigest = createHash('sha256').update(url).digest('hex');

    return serverHashDigest.slice(0, SERVER_ID_LENGTH);
}

/**
 * Generates a unique tool name based on the provided URL and tool name.
 * @param url The URL to generate the tool name from.
 * @param toolName The tool name to generate the tool name from.
 * @returns A unique tool name.
 */
function getProxyMCPServerToolName(url: string, toolName: string): string {
    const prefix = getMCPServerID(url);

    const fullName = `${prefix}-${toolName}`;
    return fullName.slice(0, MAX_TOOL_NAME_LENGTH);
}

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
