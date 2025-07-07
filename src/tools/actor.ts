import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Ajv } from 'ajv';
import type { ActorCallOptions, ActorRun, Dataset, PaginatedList } from 'apify-client';
import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

import log from '@apify/log';

import { ApifyClient } from '../apify-client.js';
import {
    ACTOR_ADDITIONAL_INSTRUCTIONS,
    ACTOR_MAX_MEMORY_MBYTES,
    ACTOR_RUN_DATASET_OUTPUT_MAX_ITEMS,
    HelperTools,
} from '../const.js';
import { getActorMCPServerPath, getActorMCPServerURL } from '../mcp/actors.js';
import { connectMCPClient } from '../mcp/client.js';
import { getMCPServerTools } from '../mcp/proxy.js';
import { actorDefinitionPrunedCache } from '../state.js';
import type { ActorInfo, InternalTool, ToolEntry } from '../types.js';
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
    actorRun: ActorRun;
    datasetInfo: Dataset | undefined;
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
    actorsInfo: ActorInfo[],
): Promise<ToolEntry[]> {
    const tools: ToolEntry[] = [];

    // Zip the results with their corresponding actorIDs
    for (const actorInfo of actorsInfo) {
        const { actorDefinitionPruned } = actorInfo;

        if (actorDefinitionPruned) {
            const schemaID = getToolSchemaID(actorDefinitionPruned.actorFullName);
            if (actorDefinitionPruned.input && 'properties' in actorDefinitionPruned.input && actorDefinitionPruned.input) {
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
                        inputSchema: actorDefinitionPruned.input || {},
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

    // Filter out nulls and separate Actors with MCP servers and normal Actors
    const actorMCPServersInfo = actorsInfo.filter((actorInfo) => actorInfo && actorInfo.webServerMcpPath) as ActorInfo[];
    const normalActorsInfo = actorsInfo.filter((actorInfo) => actorInfo && !actorInfo.webServerMcpPath) as ActorInfo[];

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
        description: 'Call Actor and get dataset id. Call without input and result response with requred input properties.',
        inputSchema: zodToJsonSchema(callActorArgs),
        ajvValidate: ajv.compile(zodToJsonSchema(callActorArgs)),
        call: async (toolArgs) => {
            const { args, apifyToken } = toolArgs;
            const { actorName, input, callOptions } = callActorArgs.parse(args);
            if (!apifyToken) {
                throw new Error('APIFY_TOKEN environment variable is not set.');
            }
            try {
                // FIXME: Bug, every call add "**REQUIRED**" to the description of the input properties
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

                const { actorRun, datasetInfo, items } = await callActorGetDataset(
                    actorName,
                    input,
                    apifyToken,
                    callOptions,
                );

                return {
                    content: [
                        { type: 'text', text: `Actor run ID: ${actorRun.id}` },
                        { type: 'text', text: `Dataset ID: ${datasetInfo?.id}` },
                        { type: 'text', text: `Items count: ${items.total}` },
                    ],
                };
            } catch (error) {
                console.error(`Error calling Actor: ${error}`);
                return {
                    content: [
                        { type: 'text', text: `Error calling Actor: ${error instanceof Error ? error.message : String(error)}` },
                    ],
                };
            }
        },
    },
};
