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
import type { ActorDefinitionStorage, ActorInfo, ToolEntry } from '../types.js';
import { getActorDefinitionStorageFieldNames } from '../utils/actor.js';
import { fetchActorDetails } from '../utils/actor-details.js';
import { getValuesByDotKeys } from '../utils/generic.js';
import type { ProgressTracker } from '../utils/progress.js';
import { getActorDefinition } from './build.js';
import { actorNameToToolName, fixedAjvCompile, getToolSchemaID, transformActorInputSchemaProperties } from './utils.js';

const ajv = new Ajv({ coerceTypes: 'array', strict: false });

// Define a named return type for callActorGetDataset
export type CallActorGetDatasetResult = {
    runId: string;
    datasetId: string;
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
 * @param {ProgressTracker} progressTracker - Optional progress tracker for real-time updates.
 * @param {AbortSignal} abortSignal - Optional abort signal to cancel the actor run.
 * @returns {Promise<CallActorGetDatasetResult | null>} - A promise that resolves to an object containing the actor run and dataset items.
 * @throws {Error} - Throws an error if the `APIFY_TOKEN` is not set
 */
export async function callActorGetDataset(
    actorName: string,
    input: unknown,
    apifyToken: string,
    callOptions: ActorCallOptions | undefined = undefined,
    progressTracker?: ProgressTracker | null,
    abortSignal?: AbortSignal,
): Promise<CallActorGetDatasetResult | null> {
    const CLIENT_ABORT = Symbol('CLIENT_ABORT'); // Just internal symbol to identify client abort
    try {
        const client = new ApifyClient({ token: apifyToken });
        const actorClient = client.actor(actorName);

        // Start the actor run
        const actorRun: ActorRun = await actorClient.start(input, callOptions);

        // Start progress tracking if tracker is provided
        if (progressTracker) {
            progressTracker.startActorRunUpdates(actorRun.id, apifyToken, actorName);
        }

        // Create abort promise that handles both API abort and race rejection
        const abortPromise = async () => new Promise<typeof CLIENT_ABORT>((resolve) => {
            abortSignal?.addEventListener('abort', async () => {
                // Abort the actor run via API
                try {
                    await client.run(actorRun.id).abort({ gracefully: false });
                } catch (e) {
                    log.error('Error aborting Actor run', { error: e, runId: actorRun.id });
                }
                // Reject to stop waiting
                resolve(CLIENT_ABORT);
            }, { once: true });
        });

        // Wait for completion or cancellation
        const potentialAbortedRun = await Promise.race([
            client.run(actorRun.id).waitForFinish(),
            ...(abortSignal ? [abortPromise()] : []),
        ]);

        if (potentialAbortedRun === CLIENT_ABORT) {
            log.info('Actor run aborted by client', { actorName, input });
            return null;
        }
        const completedRun = potentialAbortedRun as ActorRun;

        // Process the completed run
        const dataset = client.dataset(completedRun.defaultDatasetId);
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

        log.debug('Actor finished', { actorName, itemCount: items.count });
        return { runId: actorRun.id, datasetId: completedRun.defaultDatasetId, items };
    } catch (error) {
        log.error('Error calling actor', { error, actorName, input });
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
 * @param {ActorInfo[]} actorsInfo - An array of ActorInfo objects with webServerMcpPath and actorDefinitionPruned.
 * @returns {Promise<ToolEntry[]>} - A promise that resolves to an array of MCP tools.
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
                actorDefinitionPruned.input.properties = transformActorInputSchemaProperties(actorDefinitionPruned.input);
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
                        description: `This tool calls the Actor "${actorDefinitionPruned.actorFullName}" and retrieves its output results. Use this tool instead of the "${HelperTools.ACTOR_CALL}" if user requests to use this specific Actor.
Actor description: ${actorDefinitionPruned.description}
Instructions: ${ACTOR_ADDITIONAL_INSTRUCTIONS}`,
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
                log.error('Failed to compile AJV schema for Actor', { actorName: actorDefinitionPruned.actorFullName, error: validationError });
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
        log.debug('Retrieved MCP server URL for Actor', {
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
    log.debug('Fetching actors as tools', { actorNames: actorIdsOrNames });

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
                log.error('Actor not found or definition is not available', { actorName: actorIdOrName });
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

const callActorArgs = z.object({
    actor: z.string()
        .describe('The name of the Actor to call. For example, "apify/rag-web-browser".'),
    step: z.enum(['info', 'call'])
        .default('info')
        .describe(`Step to perform: "info" to get Actor details and input schema (required first step), "call" to execute the Actor (only after getting info).`),
    input: z.object({}).passthrough()
        .optional()
        .describe(`The input JSON to pass to the Actor. For example, {"query": "apify", "maxResults": 5, "outputFormats": ["markdown"]}. Required only when step is "call".`),
    callOptions: z.object({
        memory: z.number()
            .min(128, 'Memory must be at least 128 MB')
            .max(32768, 'Memory cannot exceed 32 GB (32768 MB)')
            .optional()
            .describe(`Memory allocation for the Actor in MB. Must be a power of 2 (e.g., 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768). Minimum: 128 MB, Maximum: 32768 MB (32 GB).`),
        timeout: z.number()
            .min(0, 'Timeout must be 0 or greater')
            .optional()
            .describe(`Maximum runtime for the Actor in seconds. After this time elapses, the Actor will be automatically terminated. Use 0 for infinite timeout (no time limit). Minimum: 0 seconds (infinite).`),
    }).optional()
        .describe('Optional call options for the Actor run configuration.'),
});

export const callActor: ToolEntry = {
    type: 'internal',
    tool: {
        name: HelperTools.ACTOR_CALL,
        actorFullName: HelperTools.ACTOR_CALL,
        description: `Call Any Actor from Apify Store - Two-Step Process

This tool uses a mandatory two-step process to safely call any Actor from the Apify store.

USAGE:
• ONLY for Actors that are NOT available as dedicated tools
• If a dedicated tool exists (e.g., ${actorNameToToolName('apify/rag-web-browser')}), use that instead

MANDATORY TWO-STEP WORKFLOW:

Step 1: Get Actor Info (step="info", default)
• First call this tool with step="info" to get Actor details and input schema
• This returns the Actor description, documentation, and required input schema
• You MUST do this step first - it's required to understand how to call the Actor

Step 2: Call Actor (step="call") 
• Only after step 1, call again with step="call" and proper input based on the schema
• This executes the Actor and returns the results

The step parameter enforces this workflow - you cannot call an Actor without first getting its info.`,
        inputSchema: zodToJsonSchema(callActorArgs),
        ajvValidate: ajv.compile(zodToJsonSchema(callActorArgs)),
        call: async (toolArgs) => {
            const { args, apifyToken, progressTracker, extra } = toolArgs;
            const { actor: actorName, step, input, callOptions } = callActorArgs.parse(args);

            try {
                if (step === 'info') {
                    // Step 1: Return actor card and schema directly
                    const details = await fetchActorDetails(apifyToken, actorName);
                    if (!details) {
                        return {
                            content: [{ type: 'text', text: `Actor information for '${actorName}' was not found. Please check the Actor ID or name and ensure the Actor exists.` }],
                        };
                    }
                    return {
                        content: [
                            { type: 'text', text: `**Input Schema:**\n${JSON.stringify(details.inputSchema, null, 0)}` },
                        ],
                    };
                }
                // Step 2: Call the Actor
                if (!input) {
                    return {
                        content: [
                            { type: 'text', text: `Input is required when step="call". Please provide the input parameter based on the Actor's input schema.` },
                        ],
                    };
                }

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
                                { type: 'text', text: `Input Schema:\n${JSON.stringify(actor.tool.inputSchema)}` },
                            ],
                        };
                    }
                }

                const result = await callActorGetDataset(
                    actorName,
                    input,
                    apifyToken,
                    callOptions,
                    progressTracker,
                    extra.signal,
                );

                if (!result) {
                    // Receivers of cancellation notifications SHOULD NOT send a response for the cancelled request
                    // https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation#behavior-requirements
                    return { };
                }

                const { runId, datasetId, items } = result;

                const content = [
                    { type: 'text', text: `Actor finished with runId: ${runId}, datasetId ${datasetId}` },
                ];

                const itemContents = items.items.map((item: Record<string, unknown>) => ({
                    type: 'text',
                    text: JSON.stringify(item),
                }));
                content.push(...itemContents);

                return { content };
            } catch (error) {
                log.error('Error with Actor operation', { error, actorName, step });
                return {
                    content: [
                        { type: 'text', text: `Error with Actor operation: ${error instanceof Error ? error.message : String(error)}` },
                    ],
                };
            }
        },
    },
};
