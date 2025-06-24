import { createHash } from 'node:crypto';
import { parse } from 'node:querystring';

import type { PaginatedList } from 'apify-client';

import { ACTOR_OUTPUT_TRUNCATED_MESSAGE } from '../const.js';
import { processInput } from '../input.js';
import { addRemoveTools, getActorsAsTools } from '../tools/index.js';
import type { Input, ToolEntry } from '../types.js';
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
    return tools;
}

export function parseInputParamsFromUrl(url: string): Input {
    const query = url.split('?')[1] || '';
    const params = parse(query) as unknown as Input;
    return processInput(params);
}

/**
 * Truncates dataset items to fit within a specified character limit.
 *
 * This function will remove items from the end of the dataset until the total
 * character count of the dataset items is within the specified limit.
 * If there is only one item (left) in the dataset, it will not be truncated.
 */
export function truncateDatasetItems(
    items: PaginatedList<Record<string, unknown>>,
    maxChars: number,
    originalItemCount: number,
): PaginatedList<Record<string, unknown>> {
    // If within the limit, return as is.
    if (JSON.stringify(items).length <= maxChars) {
        return items;
    }

    // Do not truncate single item datasets.
    if (items.items.length < 2) {
        return items;
    }

    // Truncate from back and check if the total length is within the limit.
    while (items.items.length > 1) {
        if (JSON.stringify(items).length <= maxChars) {
            break; // If the dataset is within the limit, stop truncating.
        }
        items.items.pop(); // Remove the last item if the dataset exceeds the limit.
    }

    // Add truncation message
    items.items.push({
        truncationInfo: ACTOR_OUTPUT_TRUNCATED_MESSAGE,
        originalItemCount,
        itemCountAfterTruncation: items.items.length,
    });

    return items;
}
