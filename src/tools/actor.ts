import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ActorCallOptions, ActorRun } from 'apify-client';
import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

import log from '@apify/log';

import { ApifyClient } from '../apify-client.js';
import {
    ACTOR_MAX_MEMORY_MBYTES,
    CALL_ACTOR_MCP_MISSING_TOOL_NAME_MSG,
    HelperTools,
    RAG_WEB_BROWSER,
    RAG_WEB_BROWSER_ADDITIONAL_DESC,
    SKYFIRE_TOOL_INSTRUCTIONS,
    TOOL_MAX_OUTPUT_CHARS,
} from '../const.js';
import { getActorMCPServerPath, getActorMCPServerURL } from '../mcp/actors.js';
import { connectMCPClient } from '../mcp/client.js';
import { getMCPServerTools } from '../mcp/proxy.js';
import { actorDefinitionPrunedCache } from '../state.js';
import type { ActorDefinitionStorage, ActorInfo, ApifyToken, DatasetItem, McpInputSchema, ToolEntry } from '../types.js';
import { ensureOutputWithinCharLimit, getActorDefinitionStorageFieldNames, getActorMcpUrlCached } from '../utils/actor.js';
import { fetchActorDetails } from '../utils/actor-details.js';
import { buildActorResponseContent } from '../utils/actor-response.js';
import { ajv } from '../utils/ajv.js';
import { buildMCPResponse } from '../utils/mcp.js';
import type { ProgressTracker } from '../utils/progress.js';
import type { JsonSchemaProperty } from '../utils/schema-generation.js';
import { generateSchemaFromItems } from '../utils/schema-generation.js';
import { getActorDefinition } from './build.js';
import { actorNameToToolName, buildActorInputSchema, fixedAjvCompile } from './utils.js';

// Define a named return type for callActorGetDataset
export type CallActorGetDatasetResult = {
    runId: string;
    datasetId: string;
    itemCount: number;
    schema: JsonSchemaProperty;
    previewItems: DatasetItem[];
};

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

    for (const actorInfo of actorsInfo) {
        const { actorDefinitionPruned } = actorInfo;

        if (!actorDefinitionPruned) continue;

        const isRag = actorDefinitionPruned.actorFullName === RAG_WEB_BROWSER;
        const { inputSchema } = buildActorInputSchema(actorDefinitionPruned.actorFullName, actorDefinitionPruned.input, isRag);

        let description = `This tool calls the Actor "${actorDefinitionPruned.actorFullName}" and retrieves its output results.
Use this tool instead of the "${HelperTools.ACTOR_CALL}" if user requests this specific Actor.
Actor description: ${actorDefinitionPruned.description}`;
        if (isRag) {
            description += RAG_WEB_BROWSER_ADDITIONAL_DESC;
        }

        const memoryMbytes = Math.min(
            actorDefinitionPruned.defaultRunOptions?.memoryMbytes || ACTOR_MAX_MEMORY_MBYTES,
            ACTOR_MAX_MEMORY_MBYTES,
        );

        let ajvValidate;
        try {
            ajvValidate = fixedAjvCompile(ajv, { ...inputSchema, additionalProperties: true });
        } catch (e) {
            log.error('Failed to compile schema', {
                actorName: actorDefinitionPruned.actorFullName,
                error: e,
            });
            continue;
        }

        tools.push({
            type: 'actor',
            tool: {
                name: actorNameToToolName(actorDefinitionPruned.actorFullName),
                actorFullName: actorDefinitionPruned.actorFullName,
                description,
                inputSchema: inputSchema as McpInputSchema,
                ajvValidate,
                memoryMbytes,
            },
        });
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

    // Process all actors in parallel
    const actorToolPromises = actorsInfo.map(async (actorInfo) => {
        const actorId = actorInfo.actorDefinitionPruned.id;
        if (!actorInfo.webServerMcpPath) {
            log.warning('Actor does not have a web server MCP path, skipping', {
                actorFullName: actorInfo.actorDefinitionPruned.actorFullName,
                actorId,
            });
            return [];
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

        let client: Client | null = null;
        try {
            client = await connectMCPClient(mcpServerUrl, apifyToken);
            if (!client) {
                // Skip this Actor, connectMCPClient will log the error
                return [];
            }
            return await getMCPServerTools(actorId, client, mcpServerUrl);
        } finally {
            if (client) await client.close();
        }
    });

    // Wait for all actors to be processed in parallel
    const actorToolsArrays = await Promise.all(actorToolPromises);

    // Flatten the arrays of tools
    return actorToolsArrays.flat();
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

const callActorArgs = z.object({
    actor: z.string()
        .describe('The name of the Actor to call. For example, "apify/rag-web-browser".'),
    step: z.enum(['info', 'call'])
        .describe(`Step to perform: "info" to get Actor details and input schema (required first step), "call" to run the Actor (only after getting info).`),
    input: z.object({}).passthrough()
        .optional()
        .describe(`The input JSON to pass to the Actor. For example, {"query": "apify", "maxResults": 5}. Must be used only when step="call".`),
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
        description: `Call any Actor from the Apify Store using a mandatory two-step workflow.
This ensures you first get the Actor’s input schema and details before executing it safely.

There are two ways to run Actors:
1. Dedicated Actor tools (e.g., ${actorNameToToolName('apify/rag-web-browser')}): These are pre-configured tools, offering a simpler and more direct experience.
2. Generic call-actor tool (${HelperTools.ACTOR_CALL}): Use this when a dedicated tool is not available or when you want to run any Actor dynamically. This tool is especially useful if you do not want to add specific tools or your client does not support dynamic tool registration.

**Important:**

Typically, a successful run returns a \`datasetId\` (the Actor's output stored as an Apify dataset) and a short preview of items.
To fetch the full output, use the ${HelperTools.ACTOR_OUTPUT_GET} tool with the \`datasetId\`.

USAGE:
- Always use dedicated tools when available (e.g., ${actorNameToToolName('apify/rag-web-browser')})
- Use the generic call-actor tool only if a dedicated tool does not exist for your Actor.

MANDATORY TWO-STEP-WORKFLOW:
Step 1: Get Actor Info (step="info", default)
- First call this tool with step="info" to get Actor details and input schema
- This returns the Actor description, documentation, and required input schema
- You MUST do this step first - it's required to understand how to call the Actor

Step 2: Call Actor (step="call")
- Only after step 1, call this tool again with step="call" and proper input based on the schema
- This runs the Actor. It will create an output as an Apify dataset (with datasetId).
- This step returns a dataset preview, typically JSON-formatted tabular data.

EXAMPLES:
- user_input: Get instagram posts using apify/instagram-scraper`,
        inputSchema: zodToJsonSchema(callActorArgs) as McpInputSchema,
        ajvValidate: ajv.compile({
            ...zodToJsonSchema(callActorArgs),
            // Additional props true to allow skyfire-pay-id
            additionalProperties: true,
        }),
        call: async (toolArgs) => {
            const { args, apifyToken, progressTracker, extra, apifyMcpServer } = toolArgs;
            const { actor: actorName, step, input, callOptions } = callActorArgs.parse(args);

            // If input is provided but step is not "call", we assume the user wants to call the Actor
            const performStep = input && step !== 'call' ? 'call' : step;

            // Parse special format: actor:tool
            const mcpToolMatch = actorName.match(/^(.+):(.+)$/);
            let baseActorName = actorName;
            let mcpToolName: string | undefined;

            if (mcpToolMatch) {
                baseActorName = mcpToolMatch[1];
                mcpToolName = mcpToolMatch[2];
            }

            // For definition resolution we always use token-based client; Skyfire is only for actual Actor runs
            const apifyClientForDefinition = new ApifyClient({ token: apifyToken });
            // Resolve MCP server URL
            const mcpServerUrlOrFalse = await getActorMcpUrlCached(baseActorName, apifyClientForDefinition);
            const isActorMcpServer = mcpServerUrlOrFalse && typeof mcpServerUrlOrFalse === 'string';

            // Standby Actors, thus MCPs, are not supported in Skyfire mode
            if (isActorMcpServer && apifyMcpServer.options.skyfireMode) {
                return buildMCPResponse([`MCP server Actors are not supported in Skyfire mode. Please use a regular Apify token without Skyfire.`]);
            }

            try {
                if (performStep === 'info') {
                    if (isActorMcpServer) {
                        // MCP server: list tools
                        const mcpServerUrl = mcpServerUrlOrFalse;
                        let client: Client | null = null;
                        // Nested try to ensure client is closed
                        try {
                            client = await connectMCPClient(mcpServerUrl, apifyToken);
                            if (!client) {
                                return buildMCPResponse([`Failed to connect to MCP server ${mcpServerUrl}`]);
                            }
                            const toolsResponse = await client.listTools();

                            const toolsInfo = toolsResponse.tools.map((tool) => `**${tool.name}**\n${tool.description || 'No description'}\nInput schema:\n\`\`\`json\n${JSON.stringify(tool.inputSchema)}\n\`\`\``,
                            ).join('\n\n');

                            return buildMCPResponse([`This is an MCP Server Actor with the following tools:\n\n${toolsInfo}\n\nTo call a tool, use step="call" with actor name format: "${baseActorName}:{toolName}"`]);
                        } finally {
                            if (client) await client.close();
                        }
                    } else {
                        // Regular actor: return schema
                        const details = await fetchActorDetails(apifyClientForDefinition, baseActorName);
                        if (!details) {
                            return buildMCPResponse([`Actor information for '${baseActorName}' was not found. Please check the Actor ID or name and ensure the Actor exists.`]);
                        }
                        const content = [
                            `Actor name: ${actorName}`,
                            `Input schema:\n\`\`\`json\n${JSON.stringify(details.inputSchema)}\n\`\`\``,
                            `To run Actor, use step="call" with Actor name format: "${actorName}"`,
                        ];
                        // Add Skyfire instructions also in the info performStep since clients are most likely truncating
                        // the long tool description of the call-actor.
                        if (apifyMcpServer.options.skyfireMode) {
                            content.push(SKYFIRE_TOOL_INSTRUCTIONS);
                        }
                        return buildMCPResponse(content);
                    }
                }

                /**
                 * In Skyfire mode, we check for the presence of `skyfire-pay-id`.
                 * If it is missing, we return instructions to the LLM on how to create it and pass it to the tool.
                 */
                if (apifyMcpServer.options.skyfireMode
                    && args['skyfire-pay-id'] === undefined
                ) {
                    return {
                        content: [{
                            type: 'text',
                            text: SKYFIRE_TOOL_INSTRUCTIONS,
                        }],
                    };
                }

                /**
                 * Create Apify token, for Skyfire mode use `skyfire-pay-id` and for normal mode use `apifyToken`.
                 */
                const apifyClient = apifyMcpServer.options.skyfireMode && typeof args['skyfire-pay-id'] === 'string'
                    ? new ApifyClient({ skyfirePayId: args['skyfire-pay-id'] })
                    : new ApifyClient({ token: apifyToken });

                // Step 2: Call the Actor
                if (!input) {
                    return buildMCPResponse([`Input is required when step="call". Please provide the input parameter based on the Actor's input schema.`]);
                }

                // Handle the case where LLM does not respect instructions when calling MCP server Actors
                // and does not provide the tool name.
                const isMcpToolNameInvalid = mcpToolName === undefined || mcpToolName.trim().length === 0;
                if (isActorMcpServer && isMcpToolNameInvalid) {
                    return buildMCPResponse([CALL_ACTOR_MCP_MISSING_TOOL_NAME_MSG]);
                }

                // Handle MCP tool calls
                if (mcpToolName) {
                    if (!isActorMcpServer) {
                        return buildMCPResponse([`Actor '${baseActorName}' is not an MCP server.`]);
                    }

                    const mcpServerUrl = mcpServerUrlOrFalse;
                    let client: Client | null = null;
                    try {
                        client = await connectMCPClient(mcpServerUrl, apifyToken);
                        if (!client) {
                            return buildMCPResponse([`Failed to connect to MCP server ${mcpServerUrl}`]);
                        }

                        const result = await client.callTool({
                            name: mcpToolName,
                            arguments: input,
                        });

                        return { content: result.content };
                    } finally {
                        if (client) await client.close();
                    }
                }

                // Handle regular Actor calls
                const [actor] = await getActorsAsTools([actorName], apifyClient);

                if (!actor) {
                    return buildMCPResponse([`Actor '${actorName}' was not found.`]);
                }

                if (!actor.tool.ajvValidate(input)) {
                    const { errors } = actor.tool.ajvValidate;
                    const content = [
                        `Input validation failed for Actor '${actorName}'. Please ensure your input matches the Actor's input schema.`,
                        `Input schema:\n\`\`\`json\n${JSON.stringify(actor.tool.inputSchema)}\n\`\`\``,
                    ];
                    if (errors && errors.length > 0) {
                        content.push(`Validation errors: ${errors.map((e) => e.message).join(', ')}`);
                    }
                    return buildMCPResponse(content);
                }

                const callResult = await callActorGetDataset(
                    actorName,
                    input,
                    apifyClient,
                    callOptions,
                    progressTracker,
                    extra.signal,
                );

                if (!callResult) {
                    // Receivers of cancellation notifications SHOULD NOT send a response for the cancelled request
                    // https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation#behavior-requirements
                    return {};
                }

                const content = buildActorResponseContent(actorName, callResult);

                return { content };
            } catch (error) {
                log.error('Failed to call Actor', { error, actorName, performStep });
                return buildMCPResponse([`Failed to call Actor '${actorName}': ${error instanceof Error ? error.message : String(error)}`]);
            }
        },
    },
};
