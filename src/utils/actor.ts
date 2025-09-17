import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ActorCallOptions, ActorRun } from 'apify-client';

import log from '@apify/log';

import type { ApifyClient } from '../apify-client.js';
import {
    ACTOR_ADDITIONAL_INSTRUCTIONS,
    ACTOR_MAX_MEMORY_MBYTES,
    HelperTools,
    TOOL_MAX_OUTPUT_CHARS,
} from '../const.js';
import { getActorMCPServerPath, getActorMCPServerURL } from '../mcp/actors.js';
import { connectMCPClient } from '../mcp/client.js';
import { getMCPServerTools } from '../mcp/proxy.js';
import { actorDefinitionPrunedCache, mcpServerCache } from '../state.js';
import { getActorDefinition } from '../tools/build.js';
import { actorNameToToolName, fixedAjvCompile, getToolSchemaID, transformActorInputSchemaProperties } from '../tools/utils.js';
import type { ActorDefinitionStorage, ActorInfo, ApifyToken, DatasetItem, ToolEntry } from '../types.js';
import { ajv } from '../utils/ajv.js';
import type { ProgressTracker } from '../utils/progress.js';
import type { JsonSchemaProperty } from '../utils/schema-generation.js';
import { generateSchemaFromItems } from '../utils/schema-generation.js';
import { getValuesByDotKeys } from './generic.js';

// Define a named return type for callActorGetDataset
export type CallActorGetDatasetResult = {
    runId: string;
    datasetId: string;
    itemCount: number;
    schema: JsonSchemaProperty;
    previewItems: DatasetItem[];
};

/**
 * Resolve and cache the MCP server URL for the given Actor.
 * - Returns a string URL when the Actor exposes an MCP server
 * - Returns false when the Actor is not an MCP server
 * Uses a TTL LRU cache to avoid repeated API calls.
 */
export async function getActorMcpUrlCached(
    actorIdOrName: string,
    apifyClient: ApifyClient,
): Promise<string | false> {
    const cached = mcpServerCache.get(actorIdOrName);
    if (cached !== null && cached !== undefined) {
        return cached as string | false;
    }

    const actorDefinitionPruned = await getActorDefinition(actorIdOrName, apifyClient);
    const mcpPath = actorDefinitionPruned && getActorMCPServerPath(actorDefinitionPruned);
    if (actorDefinitionPruned && mcpPath) {
        const url = await getActorMCPServerURL(actorDefinitionPruned.id, mcpPath);
        mcpServerCache.set(actorIdOrName, url);
        return url;
    }

    mcpServerCache.set(actorIdOrName, false);
    return false;
}

/**
 * Calls an Apify Actor and retrieves metadata about the dataset results.
 *
 * This function executes an Actor and returns summary information instead with a result items preview of the full dataset
 * to prevent overwhelming responses. The actual data can be retrieved using the get-actor-output tool.
 *
 * It requires the `APIFY_TOKEN` environment variable to be set.
 * If the `APIFY_IS_AT_HOME` the dataset items are pushed to the Apify dataset.
 *
 * @param {string} actorName - The name of the Actor to call.
 * @param {unknown} input - The input to pass to the actor.
 * @param {ApifyClient} apifyClient - The Apify client to use for authentication.
 * @param {ActorCallOptions} callOptions - The options to pass to the Actor.
 * @param {ProgressTracker} progressTracker - Optional progress tracker for real-time updates.
 * @param {AbortSignal} abortSignal - Optional abort signal to cancel the actor run.
 * @returns {Promise<CallActorGetDatasetResult | null>} - A promise that resolves to an object containing the actor run and dataset items.
 * @throws {Error} - Throws an error if the `APIFY_TOKEN` is not set
 */
export async function callActorGetDataset(
    actorName: string,
    input: unknown,
    apifyClient: ApifyClient,
    callOptions: ActorCallOptions | undefined = undefined,
    progressTracker?: ProgressTracker | null,
    abortSignal?: AbortSignal,
): Promise<CallActorGetDatasetResult | null> {
    const CLIENT_ABORT = Symbol('CLIENT_ABORT'); // Just internal symbol to identify client abort
    const actorClient = apifyClient.actor(actorName);

    // Start the actor run
    const actorRun: ActorRun = await actorClient.start(input, callOptions);

    // Start progress tracking if tracker is provided
    if (progressTracker) {
        progressTracker.startActorRunUpdates(actorRun.id, apifyClient, actorName);
    }

    // Create abort promise that handles both API abort and race rejection
    const abortPromise = async () => new Promise<typeof CLIENT_ABORT>((resolve) => {
        abortSignal?.addEventListener('abort', async () => {
            // Abort the actor run via API
            try {
                await apifyClient.run(actorRun.id).abort({ gracefully: false });
            } catch (e) {
                log.error('Error aborting Actor run', { error: e, runId: actorRun.id });
            }
            // Reject to stop waiting
            resolve(CLIENT_ABORT);
        }, { once: true });
    });

    // Wait for completion or cancellation
    const potentialAbortedRun = await Promise.race([
        apifyClient.run(actorRun.id).waitForFinish(),
        ...(abortSignal ? [abortPromise()] : []),
    ]);

    if (potentialAbortedRun === CLIENT_ABORT) {
        log.info('Actor run aborted by client', { actorName, input });
        return null;
    }
    const completedRun = potentialAbortedRun as ActorRun;

    // Process the completed run
    const dataset = apifyClient.dataset(completedRun.defaultDatasetId);
    const [datasetItems, defaultBuild] = await Promise.all([
        dataset.listItems(),
        (await actorClient.defaultBuild()).get(),
    ]);

    // Generate schema using the shared utility
    const generatedSchema = generateSchemaFromItems(datasetItems.items, {
        clean: true,
        arrayMode: 'all',
    });
    const schema = generatedSchema || { type: 'object', properties: {} };

    /**
     * Get important fields that are using in any dataset view as they MAY be used in filtering to ensure the output fits
     * the tool output limits. Client has to use the get-actor-output tool to retrieve the full dataset or filtered out fields.
     */
    const storageDefinition = defaultBuild?.actorDefinition?.storages?.dataset as ActorDefinitionStorage | undefined;
    const importantProperties = getActorDefinitionStorageFieldNames(storageDefinition || {});
    const previewItems = ensureOutputWithinCharLimit(datasetItems.items, importantProperties, TOOL_MAX_OUTPUT_CHARS);

    return {
        runId: actorRun.id,
        datasetId: completedRun.defaultDatasetId,
        itemCount: datasetItems.count,
        schema,
        previewItems,
    };
}

/**
 * This function is used to fetch normal non-MCP server Actors as a tool.
 *
 * Fetches Actor input schemas by Actor IDs or Actor full names and creates MCP tools.
 *
 * This function retrieves the input schemas for the specified Actors and compiles them into MCP tools.
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
                        // Additional props true to allow skyfire-pay-id
                        ajvValidate: fixedAjvCompile(ajv, { ...actorDefinitionPruned.input, additionalProperties: true }),
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
    apifyToken: ApifyToken,
): Promise<ToolEntry[]> {
    /**
     * This is case for the Skyfire request without any Apify token, we do not support
     * standby Actors in this case so we can skip MCP servers since they would fail anyway (they are standby Actors).
     */
    if (apifyToken === null || apifyToken === undefined) {
        return [];
    }

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
    apifyClient: ApifyClient,
): Promise<ToolEntry[]> {
    log.debug('Fetching Actors as tools', { actorNames: actorIdsOrNames });

    const actorsInfo: (ActorInfo | null)[] = await Promise.all(
        actorIdsOrNames.map(async (actorIdOrName) => {
            const actorDefinitionPrunedCached = actorDefinitionPrunedCache.get(actorIdOrName);
            if (actorDefinitionPrunedCached) {
                return {
                    actorDefinitionPruned: actorDefinitionPrunedCached,
                    webServerMcpPath: getActorMCPServerPath(actorDefinitionPrunedCached),

                } as ActorInfo;
            }

            const actorDefinitionPruned = await getActorDefinition(actorIdOrName, apifyClient);
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
        getMCPServersAsTools(actorMCPServersInfo, apifyClient.token),
    ]);

    return [...normalTools, ...mcpServerTools];
}

/**
 * Returns an array of all field names mentioned in the display.properties
 * of all views in the given ActorDefinitionStorage object.
 */
export function getActorDefinitionStorageFieldNames(storage: ActorDefinitionStorage | object): string[] {
    const fieldSet = new Set<string>();
    if ('views' in storage && typeof storage.views === 'object' && storage.views !== null) {
        for (const view of Object.values(storage.views)) {
            // Collect from display.properties
            if (view.display && view.display.properties) {
                Object.keys(view.display.properties).forEach((field) => fieldSet.add(field));
            }
            // Collect from transformation.fields
            if (view.transformation && Array.isArray(view.transformation.fields)) {
                view.transformation.fields.forEach((field) => {
                    if (typeof field === 'string') fieldSet.add(field);
                });
            }
        }
    }
    return Array.from(fieldSet);
}

/**
 * Ensures the Actor output items are within the character limit.
 *
 * First checks if all items fit into the limit, then tries only the important fields and as a last resort
 * starts removing items until within the limit. In worst scenario return empty array.
 *
 * This is primarily used to ensure the tool output does not exceed the LLM context length or tool output limit.
 */
export function ensureOutputWithinCharLimit(items: DatasetItem[], importantFields: string[], charLimit: number): DatasetItem[] {
    // Check if all items fit into the limit
    const allItemsString = JSON.stringify(items);
    if (allItemsString.length <= charLimit) {
        return items;
    }

    /**
     * Items used for the final fallback - removing items until within the limit.
     * If important fields are defined, use only those fields for that fallback step.
     */
    let sourceItems = items;
    // Try only the important fields
    if (importantFields.length > 0) {
        const importantItems = items.map((item) => getValuesByDotKeys(item, importantFields));
        const importantItemsString = JSON.stringify(importantItems);
        if (importantItemsString.length <= charLimit) {
            return importantItems;
        }
        sourceItems = importantItems;
    }

    // Start removing items until within the limit
    const result: DatasetItem[] = [];
    for (const item of sourceItems) {
        if (JSON.stringify(result.concat(item)).length > charLimit) {
            break;
        }
        result.push(item);
    }
    return result;
}
