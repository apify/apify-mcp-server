
import { createHash } from "node:crypto";
import { MAX_TOOL_NAME_LENGTH, SERVER_ID_LENGTH } from "./const.js";

import { parse } from 'node:querystring';
import { processInput } from '../input.js';
import type { ToolWrap } from '../types.js';

import { addTool, getActorsAsTools, removeTool } from '../tools/index.js';
import { Input } from "../types.js";
import { APIFY_USERNAME } from "../const.js";
import { ActorDefinition } from "apify-client";
import { ApifyClient } from "../apify-client.js";

/**
 * Generates a unique server ID based on the provided URL.
 *
 * URL is used instead of Actor ID becase one Actor may expose multiple servers - legacy SSE / streamable HTTP.
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
 */
export async function processParamsGetTools(url: string, apifyToken: string) {
    const input = parseInputParamsFromUrl(url);
    let tools: ToolWrap[] = [];
    if (input.actors) {
        const actors = input.actors as string[];
        // Normal Actors as a tool
        tools = await getActorsAsTools(actors, apifyToken);
    }
    if (input.enableActorAutoLoading) {
        tools.push(addTool, removeTool);
    }
    return tools;
}

export function parseInputParamsFromUrl(url: string): Input {
    const query = url.split('?')[1] || '';
    const params = parse(query) as unknown as Input;
    return processInput(params);
}

/**
* Returns standby URL for given Actor ID.
*
* @param actorID
* @param standbyBaseUrl
* @returns
*/
export function getActorStandbyURL(actorID: string, standbyBaseUrl = 'apify.actor'): string {
    const actorOwner = actorID.split('/')[0];
    const actorName = actorID.split('/')[1];
    if (!actorOwner || !actorName) {
        throw new Error(`Invalid actor ID: ${actorID}`);
    }

    const actorOwnerDNSFriendly = actorOwner.replace('.', '-');
    const prefix = actorOwner === APIFY_USERNAME ? '' : `${actorOwnerDNSFriendly}--`;

    return `https://${prefix}${actorName}.${standbyBaseUrl}`;
}

export async function getActorDefinition(actorID: string, apifyToken: string): Promise<ActorDefinition> {
    const apifyClient = new ApifyClient({ token: apifyToken
     })
    const actor = apifyClient.actor(actorID);
    const info = await actor.get();
    if (!info) {
        throw new Error(`Actor ${actorID} not found`);
    }
    const latestBuildID = info.taggedBuilds?.['latest']?.buildId;
    if (!latestBuildID) {
        throw new Error(`Actor ${actorID} does not have a latest build`);
    }
    const build = apifyClient.build(latestBuildID);
    const buildInfo = await build.get();
    if (!buildInfo) {
        throw new Error(`Build ${latestBuildID} not found`);
    }
    const actorDefinition = buildInfo.actorDefinition;
    if (!actorDefinition) {
        throw new Error(`Build ${latestBuildID} does not have an actor definition`);
    }

    return actorDefinition;
}
