import { createHash } from 'node:crypto';

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { fixedAjvCompile } from '../tools/actor_input_schema.js';
import { parseActorFullName } from '../tools/actor_tool_naming.js';
import type { ActorMcpTool, ToolEntry } from '../types.js';
import { TOOL_TYPE } from '../types.js';
import { ajv } from '../utils/ajv.js';
import { MAX_TOOL_NAME_AUTHOR_LENGTH, MAX_TOOL_NAME_LENGTH, SERVER_ID_LENGTH, TOOL_NAME_HASH_LENGTH } from './const.js';

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
 * Prefixes the tool name with the Actor's `{username}--{actor-name}`, so proxied tools read
 * the same way direct Actor tools do. Over-length names get a hash suffix (same pattern as
 * actor tool names) so bare truncation cannot collide two different origin tool names into
 * one exposed name.
 *
 * Over the limit the username is capped to `MAX_TOOL_NAME_AUTHOR_LENGTH` first, because plain
 * tail truncation eats the tool name — the half a model needs to pick a tool. The cap is a
 * constant and not fitted to each name: all tools of one Actor must keep a byte-identical
 * prefix, and a per-name cap would give one Actor a different prefix per tool.
 */
export function getProxyMCPServerToolName(actorFullName: string, toolName: string): string {
    const { escapedUsername, actorName } = parseActorFullName(actorFullName);
    const actorAndToolName = `${actorName}--${toolName}`;
    const fullName = escapedUsername === null ? actorAndToolName : `${escapedUsername}--${actorAndToolName}`;

    if (fullName.length <= MAX_TOOL_NAME_LENGTH) {
        return fullName;
    }

    // Hashed over the uncapped name, so the suffix is the same whichever of the two returns below wins.
    const hash = createHash('sha256').update(fullName).digest('hex').slice(0, TOOL_NAME_HASH_LENGTH);
    // Trim a trailing dash: a cap landing on one would leave '---' where '--' separates the segments.
    const cappedName =
        escapedUsername === null
            ? fullName
            : `${escapedUsername.slice(0, MAX_TOOL_NAME_AUTHOR_LENGTH).replace(/-+$/, '')}--${actorAndToolName}`;
    const cappedNameWithHash = `${cappedName}-${hash}`;

    if (cappedNameWithHash.length <= MAX_TOOL_NAME_LENGTH) {
        return cappedNameWithHash;
    }

    return `${cappedName.slice(0, MAX_TOOL_NAME_LENGTH - TOOL_NAME_HASH_LENGTH - 1)}-${hash}`;
}

export async function getMCPServerTools(
    actorID: string,
    client: Client,
    serverUrl: string,
    actorFullName: string,
): Promise<ToolEntry[]> {
    const { tools } = await client.listTools();

    return tools.map(
        (tool): ActorMcpTool => ({
            type: TOOL_TYPE.ACTOR_MCP,
            actorId: actorID,
            serverId: getMCPServerID(serverUrl),
            serverUrl,
            originToolName: tool.name,
            name: getProxyMCPServerToolName(actorFullName, tool.name),
            description: tool.description || '',
            inputSchema: tool.inputSchema,
            ajvValidate: fixedAjvCompile(ajv, tool.inputSchema),
            annotations: tool.annotations,
        }),
    );
}
