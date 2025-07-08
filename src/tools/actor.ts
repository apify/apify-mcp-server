import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Ajv } from 'ajv';
import type { ActorCallOptions, ActorRun, PaginatedList } from 'apify-client';
import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

import log from '@apify/log';

import { ApifyClient } from '../apify-client.js';
import {
    ACTOR_ADDITIONAL_INSTRUCTIONS,
    ACTOR_MAX_MEMORY_MBYTES,
    HelperTools,
} from '../const.js';
import { getActorMCPServerPath, getActorMCPServerURL } from '../mcp/actors.js';
import { connectMCPClient } from '../mcp/client.js';
import { getMCPServerTools } from '../mcp/proxy.js';
import { actorDefinitionPrunedCache } from '../state.js';
import type { ActorDefinitionStorage, ActorInfo, InternalTool, ToolEntry } from '../types.js';
import { getActorDefinitionStorageFieldNames } from '../utils/actor.js';
import { getValuesByDotKeys } from '../utils/generic.js';
import { getActorDefinition } from './build.js';
import {
    actorNameToToolName,
    addEnumsToDescriptionsWithExamples,
    buildNestedProperties,
    filterSchemaProperties,
    fixedAjvCompile,
    getToolSchemaID,
    markInputPropertiesAsRequired,
    shortenProperties,
} from './utils.js';

const ajv = new Ajv({ coerceTypes: 'array', strict: false });

// Define a named return type for callActorGetDataset
export type CallActorGetDatasetResult = {
    items: PaginatedList<Record<string, unknown>>;
};

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
 * @returns {Promise<{ actorRun: any, items: object[] }>} - A promise that resolves to an object containing the actor run and dataset items.
 * @throws {Error} - Throws an error if the `APIFY_TOKEN` is not set
 */
export async function callActorGetDataset(
    actorName: string,
    input: unknown,
    apifyToken: string,
    callOptions: ActorCallOptions | undefined = undefined,
): Promise<CallActorGetDatasetResult> {
    try {
        log.info(`Calling Actor ${actorName} with input: ${JSON.stringify(input)}`);

        const client = new ApifyClient({ token: apifyToken });
        const actorClient = client.actor(actorName);

        const actorRun: ActorRun = await actorClient.call(input, callOptions);
        const dataset = client.dataset(actorRun.defaultDatasetId);
        // const dataset = client.dataset('Ehtn0Y4wIKviFT2WB');
        const [items, defaultBuild] = await Promise.all([
            dataset.listItems(),
            (await actorClient.defaultBuild()).get(),
        ]);

        // Get important properties from storage view definitions and if available return only those properties
        const storageDefinition = defaultBuild?.actorDefinition?.storages?.dataset as ActorDefinitionStorage | undefined;
        const importantProperties = getActorDefinitionStorageFieldNames(storageDefinition || {});
        if (importantProperties.length > 0) {
            items.items = items.items.map((item) => {
                return getValuesByDotKeys(item, importantProperties);
            });
        }

        log.info(`Actor ${actorName} finished with ${items.count} items`);

        return { items };
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
    actorsInfo: ActorInfo[],
): Promise<ToolEntry[]> {
    const tools: ToolEntry[] = [];

    // Zip the results with their corresponding actorIDs
    for (const actorInfo of actorsInfo) {
        const { actorDefinitionPruned } = actorInfo;

        if (actorDefinitionPruned) {
            const schemaID = getToolSchemaID(actorDefinitionPruned.actorFullName);
            if (actorDefinitionPruned.input && 'properties' in actorDefinitionPruned.input && actorDefinitionPruned.input) {
                // Filter non-required properties except integers if `required` is defined in the input schema and not empty.
                const { required } = actorDefinitionPruned.input;
                if (Array.isArray(required) && required.length > 0) {
                    actorDefinitionPruned.input.properties = Object.fromEntries(
                        Object.entries(actorDefinitionPruned.input.properties)
                            // Keep all integer properties, as these include
                            // properties related to output item counts that users
                            // might want to change if they need more results than the default limit.
                            .filter(([key, value]) => required.includes(key) || value.type === 'integer'),
                    );
                }

                actorDefinitionPruned.input.properties = markInputPropertiesAsRequired(actorDefinitionPruned.input);
                actorDefinitionPruned.input.properties = buildNestedProperties(actorDefinitionPruned.input.properties);
                actorDefinitionPruned.input.properties = filterSchemaProperties(actorDefinitionPruned.input.properties);
                actorDefinitionPruned.input.properties = shortenProperties(actorDefinitionPruned.input.properties);
                actorDefinitionPruned.input.properties = addEnumsToDescriptionsWithExamples(actorDefinitionPruned.input.properties);
                // Add schema $id, each valid JSON schema should have a unique $id
                // see https://json-schema.org/understanding-json-schema/basics#declaring-a-unique-identifier
                actorDefinitionPruned.input.$id = schemaID;
            }
            try {
                const memoryMbytes = actorDefinitionPruned.defaultRunOptions?.memoryMbytes || ACTOR_MAX_MEMORY_MBYTES;
                const tool: ToolEntry = {
                    type: 'actor',
                    tool: {
                        name: actorNameToToolName(actorDefinitionPruned.actorFullName),
                        actorFullName: actorDefinitionPruned.actorFullName,
                        description: `${actorDefinitionPruned.description} Instructions: ${ACTOR_ADDITIONAL_INSTRUCTIONS}`,
                        inputSchema: actorDefinitionPruned.input
                        // So Actor without input schema works - MCP client expects JSON schema valid output
                        || {
                            type: 'object',
                            properties: {},
                            required: [],
                        },
                        ajvValidate: fixedAjvCompile(ajv, actorDefinitionPruned.input || {}),
                        memoryMbytes: memoryMbytes > ACTOR_MAX_MEMORY_MBYTES ? ACTOR_MAX_MEMORY_MBYTES : memoryMbytes,
                    },
                };
                tools.push(tool);
            } catch (validationError) {
                log.error(`Failed to compile AJV schema for Actor: ${actorDefinitionPruned.actorFullName}. Error: ${validationError}`);
            }
        }
    }
    return tools;
}

async function getMCPServersAsTools(
    actorsInfo: ActorInfo[],
    apifyToken: string,
): Promise<ToolEntry[]> {
    const actorsMCPServerTools: ToolEntry[] = [];
    for (const actorInfo of actorsInfo) {
        const actorId = actorInfo.actorDefinitionPruned.id;
        if (!actorInfo.webServerMcpPath) {
            log.warning('Actor does not have a web server MCP path, skipping', {
                actorFullName: actorInfo.actorDefinitionPruned.actorFullName,
                actorId,
            });
            continue;
        }
        const mcpServerUrl = await getActorMCPServerURL(
            actorInfo.actorDefinitionPruned.id, // Real ID of the Actor
            actorInfo.webServerMcpPath,
        );
        log.info('Retrieved MCP server URL for Actor', {
            actorFullName: actorInfo.actorDefinitionPruned.actorFullName,
            actorId,
            mcpServerUrl,
        });

        let client: Client | undefined;
        try {
            client = await connectMCPClient(mcpServerUrl, apifyToken);
            const serverTools = await getMCPServerTools(actorId, client, mcpServerUrl);
            actorsMCPServerTools.push(...serverTools);
        } finally {
            if (client) await client.close();
        }
    }

    return actorsMCPServerTools;
}

export async function getActorsAsTools(
    actorIdsOrNames: string[],
    apifyToken: string,
): Promise<ToolEntry[]> {
    log.debug(`Fetching actors as tools...`);
    log.debug(`Actors: ${actorIdsOrNames}`);

    const actorsInfo: (ActorInfo | null)[] = await Promise.all(
        actorIdsOrNames.map(async (actorIdOrName) => {
            const actorDefinitionPrunedCached = actorDefinitionPrunedCache.get(actorIdOrName);
            if (actorDefinitionPrunedCached) {
                return {
                    actorDefinitionPruned: actorDefinitionPrunedCached,
                    webServerMcpPath: getActorMCPServerPath(actorDefinitionPrunedCached),

                } as ActorInfo;
            }

            const actorDefinitionPruned = await getActorDefinition(actorIdOrName, apifyToken);
            if (!actorDefinitionPruned) {
                log.error('Actor not found or definition is not available', { actorIdOrName });
                return null;
            }
            // Cache the pruned Actor definition
            actorDefinitionPrunedCache.set(actorIdOrName, actorDefinitionPruned);
            return {
                actorDefinitionPruned,
                webServerMcpPath: getActorMCPServerPath(actorDefinitionPruned),
            } as ActorInfo;
        }),
    );

    const clonedActors = structuredClone(actorsInfo);

    // Filter out nulls and separate Actors with MCP servers and normal Actors
    const actorMCPServersInfo = clonedActors.filter((actorInfo) => actorInfo && actorInfo.webServerMcpPath) as ActorInfo[];
    const normalActorsInfo = clonedActors.filter((actorInfo) => actorInfo && !actorInfo.webServerMcpPath) as ActorInfo[];

    const [normalTools, mcpServerTools] = await Promise.all([
        getNormalActorsAsTools(normalActorsInfo),
        getMCPServersAsTools(actorMCPServersInfo, apifyToken),
    ]);

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

const callActorArgs = z.object({
    actorName: z.string()
        .describe('The name of the Actor to call.'),
    input: z.object({}).passthrough()
        .describe('The input JSON to pass to the Actor.'),
    callOptions: z.object({
        memory: z.number().optional(),
        timeout: z.number().optional(),
    }).optional()
        .describe('Optional call options for the Actor.'),
});

export const callActor: ToolEntry = {
    type: 'internal',
    tool: {
        name: HelperTools.ACTOR_CALL,
        actorFullName: HelperTools.ACTOR_CALL,
        description: `Call Actor and get dataset results. Call without input and result response with requred input properties. Actor MUST be added before calling, use ${HelperTools.ACTOR_ADD} tool before.`,
        inputSchema: zodToJsonSchema(callActorArgs),
        ajvValidate: ajv.compile(zodToJsonSchema(callActorArgs)),
        call: async (toolArgs) => {
            const { apifyMcpServer, args, apifyToken } = toolArgs;
            const { actorName, input, callOptions } = callActorArgs.parse(args);

            const actors = apifyMcpServer.listActorToolNames();
            if (!actors.includes(actorName)) {
                const toolsText = actors.length > 0 ? `Available Actors are: ${actors.join(', ')}` : 'Not added Actors yet.';
                if (apifyMcpServer.tools.has(HelperTools.ACTOR_ADD)) {
                    return {
                        content: [{
                            type: 'text',
                            text: `Actor '${actorName}' is not added. Add it with tool '${HelperTools.ACTOR_ADD}'. ${toolsText}`,
                        }],
                    };
                }
                return {
                    content: [{
                        type: 'text',
                        text: `Actor '${actorName}' is not added. ${toolsText}
To use this MCP server, specify the actors with the parameter, for example:
?actors=apify/instagram-scraper,apify/website-content-crawler
or with the CLI:
--actors "apify/instagram-scraper,apify/website-content-crawler"
You can only use actors that are included in the list; actors not in the list cannot be used.`,
                    }],
                };
            }

            try {
                const [actor] = await getActorsAsTools([actorName], apifyToken);

                if (!actor) {
                    return {
                        content: [
                            { type: 'text', text: `Actor '${actorName}' not found.` },
                        ],
                    };
                }

                if (!actor.tool.ajvValidate(input)) {
                    const { errors } = actor.tool.ajvValidate;
                    if (errors && errors.length > 0) {
                        return {
                            content: [
                                { type: 'text', text: `Input validation failed for Actor '${actorName}': ${errors.map((e) => e.message).join(', ')}` },
                                { type: 'json', json: actor.tool.inputSchema },
                            ],
                        };
                    }
                }

                const { items } = await callActorGetDataset(
                    actorName,
                    input,
                    apifyToken,
                    callOptions,
                );

                return {
                    content: items.items.map((item: Record<string, unknown>) => ({
                        type: 'text',
                        text: JSON.stringify(item),
                    })),
                };
            } catch (error) {
                log.error(`Error calling Actor: ${error}`);
                return {
                    content: [
                        { type: 'text', text: `Error calling Actor: ${error instanceof Error ? error.message : String(error)}` },
                    ],
                };
            }
        },
    },
};
