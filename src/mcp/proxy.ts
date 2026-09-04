import { createHash } from 'node:crypto';

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { fixedAjvCompile } from '../tools/actor_input_schema.js';
import { parseActorFullName } from '../tools/actor_tool_naming.js';
import type { ActorMcpTool, ToolEntry } from '../types.js';
import { TOOL_TYPE } from '../types.js';
import { ajv } from '../utils/ajv.js';
import {
    MAX_TOOL_NAME_LENGTH,
    MAX_TOOL_NAME_USERNAME_LENGTH,
    SERVER_ID_LENGTH,
    TOOL_NAME_HASH_LENGTH,
} from './const.js';

/**
 * Generates a unique server ID by hashing the URL.
 *
 * URL is used instead of Actor ID because one Actor may expose multiple servers - legacy SSE / streamable HTTP.
 */
export function getMCPServerID(url: string): string {
    const serverHashDigest = createHash('sha256').update(url).digest('hex');

    return serverHashDigest.slice(0, SERVER_ID_LENGTH);
}

/** Formats a proxied tool name; `shouldCapUsername` keeps sibling prefixes equal. */
export function getProxyMCPServerToolName(actorFullName: string, toolName: string, shouldCapUsername = false): string {
    const { escapedUsername, actorName } = parseActorFullName(actorFullName);
    const actorAndToolName = `${actorName}--${toolName}`;
    const fullName = escapedUsername === null ? actorAndToolName : `${escapedUsername}--${actorAndToolName}`;

    if (!shouldCapUsername && fullName.length <= MAX_TOOL_NAME_LENGTH) {
        return fullName;
    }

    // Avoid merging a trailing dash with the '--' separator.
    const cappedName =
        escapedUsername === null
            ? fullName
            : `${escapedUsername.slice(0, MAX_TOOL_NAME_USERNAME_LENGTH).replace(/-+$/, '')}--${actorAndToolName}`;

    // Both truncations are lossy, so every capped name carries the hash of the uncapped one —
    // otherwise two usernames sharing the first MAX_TOOL_NAME_USERNAME_LENGTH characters collide.
    const hash = createHash('sha256').update(fullName).digest('hex').slice(0, TOOL_NAME_HASH_LENGTH);

    return `${cappedName.slice(0, MAX_TOOL_NAME_LENGTH - TOOL_NAME_HASH_LENGTH - 1)}-${hash}`;
}

export async function getMCPServerTools(
    actorID: string,
    client: Client,
    serverUrl: string,
    actorFullName: string,
): Promise<ToolEntry[]> {
    const { tools } = await client.listTools();
    const { escapedUsername, actorName } = parseActorFullName(actorFullName);
    // Keep sibling prefixes equal; see apify/apify-mcp-server#1277.
    const shouldCapUsername =
        escapedUsername !== null &&
        tools.some(({ name }) => `${escapedUsername}--${actorName}--${name}`.length > MAX_TOOL_NAME_LENGTH);

    return tools.map(
        (tool): ActorMcpTool => ({
            type: TOOL_TYPE.ACTOR_MCP,
            actorId: actorID,
            serverUrl,
            originToolName: tool.name,
            name: getProxyMCPServerToolName(actorFullName, tool.name, shouldCapUsername),
            description: tool.description || '',
            inputSchema: tool.inputSchema,
            ajvValidate: fixedAjvCompile(ajv, tool.inputSchema),
            annotations: tool.annotations,
        }),
    );
}
