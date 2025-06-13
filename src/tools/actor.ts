import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ValidateFunction } from 'ajv';
import { Ajv } from 'ajv';
import type { ActorCallOptions, ActorRun, Dataset, PaginatedList } from 'apify-client';
import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

import { LruCache } from '@apify/datastructures';
import log from '@apify/log';

import { ApifyClient } from '../apify-client.js';
import {
    ACTOR_ADDITIONAL_INSTRUCTIONS,
    ACTOR_MAX_MEMORY_MBYTES,
    ACTOR_RUN_DATASET_OUTPUT_MAX_ITEMS,
    HelperTools,
    TOOL_CACHE_MAX_SIZE,
    TOOL_CACHE_TTL_SECS,
} from '../const.js';
import { getActorsMCPServerURL, isActorMCPServer } from '../mcp/actors.js';
import { createMCPClient } from '../mcp/client.js';
import { getMCPServerTools } from '../mcp/proxy.js';
import type { InternalTool, ToolCacheEntry, ToolEntry } from '../types.js';
import { getActorDefinition } from './build.js';
import {
    actorNameToToolName,
    addEnumsToDescriptionsWithExamples,
    buildNestedProperties,
    filterSchemaProperties,
    getToolSchemaID,
    markInputPropertiesAsRequired,
    shortenProperties,
} from './utils.js';

const ajv = new Ajv({ coerceTypes: 'array', strict: false });

// source https://github.com/ajv-validator/ajv/issues/1413#issuecomment-867064234
function fixedCompile(schema: object): ValidateFunction<unknown> {
    const validate = ajv.compile(schema);
    ajv.removeSchema(schema);

    // Force reset values that aren't reset with removeSchema
    /* eslint-disable no-underscore-dangle */
    /* eslint-disable @typescript-eslint/no-explicit-any */
    (ajv.scope as any)._values.schema!.delete(schema);
    (ajv.scope as any)._values.validate!.delete(validate);
    const schemaIdx = (ajv.scope as any)._scope.schema.indexOf(schema);
    const validateIdx = (ajv.scope as any)._scope.validate.indexOf(validate);
    if (schemaIdx !== -1) (ajv.scope as any)._scope.schema.splice(schemaIdx, 1);
    if (validateIdx !== -1) (ajv.scope as any)._scope.validate.splice(validateIdx, 1);
    /* eslint-enable @typescript-eslint/no-explicit-any */
    /* eslint-enable no-underscore-dangle */
    return validate;
}

// Define a named return type for callActorGetDataset
export type CallActorGetDatasetResult = {
    actorRun: ActorRun;
    datasetInfo: Dataset | undefined;
    items: PaginatedList<Record<string, unknown>>;
};

// Cache for normal Actor tools
const normalActorToolsCache = new LruCache<ToolCacheEntry>({
    maxLength: TOOL_CACHE_MAX_SIZE,
});

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
 * @param {number} limit - The maximum number of items to retrieve from the dataset.
 * @returns {Promise<{ actorRun: any, items: object[] }>} - A promise that resolves to an object containing the actor run and dataset items.
 * @throws {Error} - Throws an error if the `APIFY_TOKEN` is not set
 */
export async function callActorGetDataset(
    actorName: string,
    input: unknown,
    apifyToken: string,
    callOptions: ActorCallOptions | undefined = undefined,
    limit = ACTOR_RUN_DATASET_OUTPUT_MAX_ITEMS,
): Promise<CallActorGetDatasetResult> {
    try {
        log.info(`Calling Actor ${actorName} with input: ${JSON.stringify(input)}`);

        const client = new ApifyClient({ token: apifyToken });
        const actorClient = client.actor(actorName);

        const actorRun: ActorRun = await actorClient.call(input, callOptions);
        const dataset = client.dataset(actorRun.defaultDatasetId);
        const [datasetInfo, items] = await Promise.all([
            dataset.get(),
            dataset.listItems({ limit }),
        ]);
        log.info(`Actor ${actorName} finished with ${datasetInfo?.itemCount} items`);

        return { actorRun, datasetInfo, items };
    } catch (error) {
        log.error(`Error calling actor: ${error}. Actor: ${actorName}, input: ${JSON.stringify(input)}`);
        throw new Error(`Error calling Actor: ${error}`);
    }
}

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
): Promise<ToolEntry[]> {
    const tools: ToolEntry[] = [];
    const actorsToLoad: string[] = [];
    for (const actorID of actors) {
        const cacheEntry = normalActorToolsCache.get(actorID);
        if (cacheEntry && cacheEntry.expiresAt > Date.now()) {
            tools.push(cacheEntry.tool);
        } else {
            actorsToLoad.push(actorID);
        }
    }
    if (actorsToLoad.length === 0) {
        return tools;
    }

    const getActorDefinitionWithToken = async (actorId: string) => {
        return await getActorDefinition(actorId, apifyToken);
    };
    const results = await Promise.all(actorsToLoad.map(getActorDefinitionWithToken));

    // Zip the results with their corresponding actorIDs
    for (let i = 0; i < results.length; i++) {
        const result = results[i];
        // We need to get the orignal input from the user
        // sonce the user can input real Actor ID like '3ox4R101TgZz67sLr' instead of
        // 'username/actorName' even though we encourage that.
        // And the getActorDefinition does not return the original input it received, just the actorFullName or actorID
        const actorIDOrName = actorsToLoad[i];

        if (result) {
            const schemaID = getToolSchemaID(result.actorFullName);
            if (result.input && 'properties' in result.input && result.input) {
                result.input.properties = markInputPropertiesAsRequired(result.input);
                result.input.properties = buildNestedProperties(result.input.properties);
                result.input.properties = filterSchemaProperties(result.input.properties);
                result.input.properties = shortenProperties(result.input.properties);
                result.input.properties = addEnumsToDescriptionsWithExamples(result.input.properties);
                // Add schema $id, each valid JSON schema should have a unique $id
                // see https://json-schema.org/understanding-json-schema/basics#declaring-a-unique-identifier
                result.input.$id = schemaID;
            }
            try {
                const memoryMbytes = result.defaultRunOptions?.memoryMbytes || ACTOR_MAX_MEMORY_MBYTES;
                const tool: ToolEntry = {
                    type: 'actor',
                    tool: {
                        name: actorNameToToolName(result.actorFullName),
                        actorFullName: result.actorFullName,
                        description: `${result.description} Instructions: ${ACTOR_ADDITIONAL_INSTRUCTIONS}`,
                        inputSchema: result.input || {},
                        ajvValidate: fixedCompile(result.input || {}),
                        memoryMbytes: memoryMbytes > ACTOR_MAX_MEMORY_MBYTES ? ACTOR_MAX_MEMORY_MBYTES : memoryMbytes,
                    },
                };
                tools.push(tool);
                normalActorToolsCache.add(actorIDOrName, {
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
): Promise<ToolEntry[]> {
    const actorsMCPServerTools: ToolEntry[] = [];
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
): Promise<ToolEntry[]> {
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

const getActorArgs = z.object({
    actorId: z.string()
        .min(1)
        .describe('Actor ID or a tilde-separated owner\'s username and Actor name.'),
});

/**
 * https://docs.apify.com/api/v2/act-get
 */
export const getActor: ToolEntry = {
    type: 'internal',
    tool: {
        name: HelperTools.ACTOR_GET,
        actorFullName: HelperTools.ACTOR_GET,
        description: 'Gets an object that contains all the details about a specific Actor.'
            + 'Actor basic information (ID, name, owner, description)'
            + 'Statistics (number of runs, users, etc.)'
            + 'Available versions, and configuration details'
            + 'Use Actor ID or Actor full name, separated by tilde username~name.',
        inputSchema: zodToJsonSchema(getActorArgs),
        ajvValidate: ajv.compile(zodToJsonSchema(getActorArgs)),
        call: async (toolArgs) => {
            const { args, apifyToken } = toolArgs;
            const { actorId } = getActorArgs.parse(args);
            const client = new ApifyClient({ token: apifyToken });
            // Get Actor - contains a lot of irrelevant information
            const actor = await client.actor(actorId).get();
            if (!actor) {
                return { content: [{ type: 'text', text: `Actor '${actorId}' not found.` }] };
            }
            return { content: [{ type: 'text', text: JSON.stringify(actor) }] };
        },
    } as InternalTool,
};
