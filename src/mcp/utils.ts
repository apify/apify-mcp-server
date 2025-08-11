import { createHash } from 'node:crypto';
import { parse } from 'node:querystring';

import { processInput } from '../input.js';
import type { Input } from '../types.js';
import { loadToolsFromInput } from '../utils/tools-loader.js';
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
 * Process input parameters from URL and get tools
 * If URL contains query parameter `actors`, return tools from Actors otherwise return null.
 * @param url
 * @param apifyToken
 */
export async function processParamsGetTools(url: string, apifyToken: string) {
    const input = parseInputParamsFromUrl(url);
    return await loadToolsFromInput(input, apifyToken);
}

export function parseInputParamsFromUrl(url: string): Input {
    const query = url.split('?')[1] || '';
    const params = parse(query) as unknown as Input;
    return processInput(params);
}
