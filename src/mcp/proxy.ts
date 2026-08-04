import { createHash } from 'node:crypto';

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { fixedAjvCompile } from '../tools/actor_input_schema.js';
import type { ActorMcpTool, ToolEntry } from '../types.js';
import { TOOL_TYPE } from '../types.js';
import { ajv } from '../utils/ajv.js';
import { MAX_TOOL_NAME_LENGTH, SERVER_ID_LENGTH, TOOL_NAME_HASH_LENGTH } from './const.js';

/**
 * Generates a unique server ID by hashing the URL.
 *
 * URL is used instead of Actor ID because one Actor may expose multiple servers - legacy SSE / streamable HTTP.
 */
export function getMCPServerID(url: string): string {
    const serverHashDigest = createHash('sha256').update(url).digest('hex');

    return serverHashDigest.slice(0, SERVER_ID_LENGTH);
}

/**
 * Prefixes the tool name with the server ID hash. Over-length names get a hash suffix
 * (same pattern as actor tool names) so bare truncation cannot collide two different
 * origin tool names into one exposed name.
 */
export function getProxyMCPServerToolName(url: string, toolName: string): string {
    const prefix = getMCPServerID(url);
    const fullName = `${prefix}-${toolName}`;

    if (fullName.length <= MAX_TOOL_NAME_LENGTH) {
        return fullName;
    }

    const hash = createHash('sha256').update(fullName).digest('hex').slice(0, TOOL_NAME_HASH_LENGTH);
    return `${fullName.slice(0, MAX_TOOL_NAME_LENGTH - TOOL_NAME_HASH_LENGTH - 1)}-${hash}`;
}

export async function getMCPServerTools(actorID: string, client: Client, serverUrl: string): Promise<ToolEntry[]> {
    const { tools } = await client.listTools();

    return tools.map(
        (tool): ActorMcpTool => ({
            type: TOOL_TYPE.ACTOR_MCP,
            actorId: actorID,
            serverId: getMCPServerID(serverUrl),
            serverUrl,
            originToolName: tool.name,
            name: getProxyMCPServerToolName(serverUrl, tool.name),
            description: tool.description || '',
            inputSchema: tool.inputSchema,
            ajvValidate: fixedAjvCompile(ajv, tool.inputSchema),
            annotations: tool.annotations,
        }),
    );
}
