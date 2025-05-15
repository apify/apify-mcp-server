import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Ajv } from 'ajv';
import type { ActorCallOptions } from 'apify-client';

import { LruCache } from '@apify/datastructures';
import log from '@apify/log';

import { ApifyClient } from '../apify-client.js';
import { ACTOR_ADDITIONAL_INSTRUCTIONS, ACTOR_MAX_MEMORY_MBYTES, TOOL_CACHE_MAX_SIZE, TOOL_CACHE_TTL_SECS } from '../const.js';
import { getActorsMCPServerURL, isActorMCPServer } from '../mcp/actors.js';
import { createMCPClient } from '../mcp/client.js';
import { getMCPServerTools } from '../mcp/proxy.js';
import type { ToolCacheEntry, ToolWrap } from '../types.js';
import { getActorDefinition } from './build.js';
import {
    actorNameToToolName,
    addEnumsToDescriptionsWithExamples,
    buildNestedProperties,
    filterSchemaProperties,
    markInputPropertiesAsRequired,
    shortenProperties,
} from './utils.js';

/**
 * Calls an Apify actor and retrieves the dataset items.
 *
 *
 * It requires the `APIFY_TOKEN` environment variable to be set.
 * If the `APIFY_IS_AT_HOME` the dataset items are pushed to the Apify dataset.
 *
 * @param {string} actorName - The name of the actor to call.
 * @param {ActorCallOptions} callOptions - The options to pass to the actor.
 * @param {unknown} input - The input to pass to the actor.
 * @param {string} apifyToken - The Apify token to use for authentication.
 * @returns {Promise<object[]>} - A promise that resolves to an array of dataset items.
 * @throws {Error} - Throws an error if the `APIFY_TOKEN` is not set
 */
export async function callActorGetDataset(
    actorName: string,
    input: unknown,
    apifyToken: string,
    callOptions: ActorCallOptions | undefined = undefined,
): Promise<object[]> {
    const name = actorName;
    try {
        log.info(`Calling Actor ${name} with input: ${JSON.stringify(input)}`);

        const client = new ApifyClient({ token: apifyToken });
        const actorClient = client.actor(name);

        const results = await actorClient.call(input, callOptions);
        const dataset = await client.dataset(results.defaultDatasetId).listItems();
        log.info(`Actor ${name} finished with ${dataset.items.length} items`);

        return dataset.items;
    } catch (error) {
        log.error(`Error calling actor: ${error}. Actor: ${name}, input: ${JSON.stringify(input)}`);
        throw new Error(`Error calling Actor: ${error}`);
    }
}

// Cache for normal Actor tools
const normalActorToolsCache = new LruCache<ToolCacheEntry>({
    maxLength: TOOL_CACHE_MAX_SIZE,
});
/**
 * This function is used to fetch normal non-MCP server Actors as a tool.
 *
 * Fetches actor input schemas by Actor IDs or Actor full names and creates MCP tools.
 *
 * This function retrieves the input schemas for the specified actors and compiles them into MCP tools.
 * It uses the AJV library to validate the input schemas.
 *
 * Tool name can't contain /, so it is replaced with _
 *
 * The input schema processing workflow:
 * 1. Properties are marked as required using markInputPropertiesAsRequired() to add "REQUIRED" prefix to descriptions
 * 2. Nested properties are built by analyzing editor type (proxy, requestListSources) using buildNestedProperties()
 * 3. Properties are filtered using filterSchemaProperties()
 * 4. Properties are shortened using shortenProperties()
 * 5. Enums are added to descriptions with examples using addEnumsToDescriptionsWithExamples()
 *
 * @param {string[]} actors - An array of actor IDs or Actor full names.
 * @param {string} apifyToken - The Apify token to use for authentication.
 * @returns {Promise<Tool[]>} - A promise that resolves to an array of MCP tools.
 */
export async function getNormalActorsAsTools(
    actors: string[],
    apifyToken: string,
): Promise<ToolWrap[]> {
    const tools: ToolWrap[] = [];
    const actorsLoadedFromCache: string[] = [];
    for (const actorID of actors) {
        const cacheEntry = normalActorToolsCache.get(actorID);
        if (cacheEntry && cacheEntry.expiresAt > Date.now()) {
            tools.push(cacheEntry.tool);
            actorsLoadedFromCache.push(actorID);
        }
    }
    const actorsToLoad = actors.filter((actorID) => !actorsLoadedFromCache.includes(actorID));
    if (actorsToLoad.length === 0) {
        return tools;
    }

    const ajv = new Ajv({ coerceTypes: 'array', strict: false });
    const getActorDefinitionWithToken = async (actorId: string) => {
        return await getActorDefinition(actorId, apifyToken);
    };
    const results = await Promise.all(actorsToLoad.map(getActorDefinitionWithToken));

    // Zip the results with their corresponding actorIDs
    for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const actorID = actorsToLoad[i];

        if (result) {
            if (result.input && 'properties' in result.input && result.input) {
                result.input.properties = markInputPropertiesAsRequired(result.input);
                result.input.properties = buildNestedProperties(result.input.properties);
                result.input.properties = filterSchemaProperties(result.input.properties);
                result.input.properties = shortenProperties(result.input.properties);
                result.input.properties = addEnumsToDescriptionsWithExamples(result.input.properties);
            }
            try {
                const memoryMbytes = result.defaultRunOptions?.memoryMbytes || ACTOR_MAX_MEMORY_MBYTES;
                const tool: ToolWrap = {
                    type: 'actor',
                    tool: {
                        name: actorNameToToolName(result.actorFullName),
                        actorFullName: result.actorFullName,
                        description: `${result.description} Instructions: ${ACTOR_ADDITIONAL_INSTRUCTIONS}`,
                        inputSchema: result.input || {},
                        ajvValidate: ajv.compile(result.input || {}),
                        memoryMbytes: memoryMbytes > ACTOR_MAX_MEMORY_MBYTES ? ACTOR_MAX_MEMORY_MBYTES : memoryMbytes,
                    },
                };
                tools.push(tool);
                normalActorToolsCache.add(actorID, {
                    tool,
                    expiresAt: Date.now() + TOOL_CACHE_TTL_SECS * 1000,
                });
            } catch (validationError) {
                log.error(`Failed to compile AJV schema for Actor: ${result.actorFullName}. Error: ${validationError}`);
            }
        }
    }
    return tools;
}

async function getMCPServersAsTools(
    actors: string[],
    apifyToken: string,
): Promise<ToolWrap[]> {
    const actorsMCPServerTools: ToolWrap[] = [];
    for (const actorID of actors) {
        const serverUrl = await getActorsMCPServerURL(actorID, apifyToken);
        log.info(`ActorID: ${actorID} MCP server URL: ${serverUrl}`);

        let client: Client | undefined;
        try {
            client = await createMCPClient(serverUrl, apifyToken);
            const serverTools = await getMCPServerTools(actorID, client, serverUrl);
            actorsMCPServerTools.push(...serverTools);
        } finally {
            if (client) await client.close();
        }
    }

    return actorsMCPServerTools;
}

export async function getActorsAsTools(
    actors: string[],
    apifyToken: string,
): Promise<ToolWrap[]> {
    log.debug(`Fetching actors as tools...`);
    log.debug(`Actors: ${actors}`);
    // Actorized MCP servers
    const actorsMCPServers: string[] = [];
    for (const actorID of actors) {
        // TODO: rework, we are fetching actor definition from API twice - in the getMCPServerTools
        if (await isActorMCPServer(actorID, apifyToken)) {
            actorsMCPServers.push(actorID);
        }
    }
    // Normal Actors as a tool
    const toolActors = actors.filter((actorID) => !actorsMCPServers.includes(actorID));
    log.debug(`actorsMCPserver: ${actorsMCPServers}`);
    log.debug(`toolActors: ${toolActors}`);

    // Normal Actors as a tool
    const normalTools = await getNormalActorsAsTools(toolActors, apifyToken);

    // Tools from Actorized MCP servers
    const mcpServerTools = await getMCPServersAsTools(actorsMCPServers, apifyToken);

    return [...normalTools, ...mcpServerTools];
}
