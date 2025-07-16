import { createHash } from 'node:crypto';
import { parse } from 'node:querystring';

import { processInput } from '../input.js';
import { addRemoveTools, betaTools, featureTools, getActorsAsTools } from '../tools/index.js';
import type { FeatureToolKey, Input, ToolEntry } from '../types.js';
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
export function getProxyMCPServerToolName(url: string, toolName: string): string {
    const prefix = getMCPServerID(url);

    const fullName = `${prefix}-${toolName}`;
    return fullName.slice(0, MAX_TOOL_NAME_LENGTH);
}

/**
 * Process input parameters and get tools
 * If URL contains query parameter `actors`, return tools from Actors otherwise return null.
 * @param url
 * @param apifyToken
 */
export async function processParamsGetTools(url: string, apifyToken: string) {
    const input = parseInputParamsFromUrl(url);
    let tools: ToolEntry[] = [];
    if (input.actors) {
        const actors = input.actors as string[];
        // Normal Actors as a tool
        tools = await getActorsAsTools(actors, apifyToken);
    }
    if (input.enableAddingActors) {
        tools.push(...addRemoveTools);
    }
    if (input.beta) {
        tools.push(...betaTools);
    }
    if (input.tools) {
        for (const toolKey of input.tools) {
            // Get tools by feature key
            const keyTools = featureTools[toolKey as FeatureToolKey] || [];
            // Push them into the tools array
            tools.push(...keyTools);
        }
    }
    return tools;
}

export function parseInputParamsFromUrl(url: string): Input {
    const query = url.split('?')[1] || '';
    const params = parse(query) as unknown as Input;
    return processInput(params);
}
