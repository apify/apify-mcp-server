import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ActorCallOptions, ActorRun } from 'apify-client';
import { z } from 'zod';

import log from '@apify/log';

import { ApifyClient } from '../apify-client.js';
import {
    ACTOR_MAX_MEMORY_MBYTES,
    CALL_ACTOR_MCP_MISSING_TOOL_NAME_MSG,
    HelperTools,
    RAG_WEB_BROWSER,
    RAG_WEB_BROWSER_ADDITIONAL_DESC,
    TOOL_MAX_OUTPUT_CHARS,
    TOOL_STATUS,
} from '../const.js';
import { getActorMCPServerPath, getActorMCPServerURL } from '../mcp/actors.js';
import { connectMCPClient } from '../mcp/client.js';
import { getMCPServerTools } from '../mcp/proxy.js';
import { actorDefinitionPrunedCache } from '../state.js';
import type { ActorDefinitionStorage, ActorInfo, ApifyToken, DatasetItem, InternalToolArgs, ToolEntry, ToolInputSchema } from '../types.js';
import { ensureOutputWithinCharLimit, getActorDefinitionStorageFieldNames, getActorMcpUrlCached } from '../utils/actor.js';
import { buildActorResponseContent } from '../utils/actor-response.js';
import { ajv, compileSchema } from '../utils/ajv.js';
import { logHttpError } from '../utils/logging.js';
import { buildMCPResponse } from '../utils/mcp.js';
import type { ProgressTracker } from '../utils/progress.js';
import type { JsonSchemaProperty } from '../utils/schema-generation.js';
import { generateSchemaFromItems } from '../utils/schema-generation.js';
import { createApifyClientWithSkyfireSupport, validateSkyfirePayId } from '../utils/skyfire.js';
import { getWidgetConfig, WIDGET_URIS } from '../utils/widgets.js';
import { getActorDefinition } from './build.js';
import { actorNameToToolName, buildActorInputSchema, fixedAjvCompile, isActorInfoMcpServer } from './utils.js';

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
                logHttpError(e, 'Error aborting Actor run', { runId: actorRun.id });
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
 * @param {ActorInfo[]} actorsInfo - An array of ActorInfo objects with webServerMcpPath, definition, and Actor.
 * @returns {Promise<ToolEntry[]>} - A promise that resolves to an array of MCP tools.
 */
export async function getNormalActorsAsTools(
    actorsInfo: ActorInfo[],
): Promise<ToolEntry[]> {
    const tools: ToolEntry[] = [];

    for (const actorInfo of actorsInfo) {
        const { definition } = actorInfo;

        if (!definition) continue;

        const isRag = definition.actorFullName === RAG_WEB_BROWSER;
        const { inputSchema } = buildActorInputSchema(definition.actorFullName, definition.input, isRag);

        let description = `This tool calls the Actor "${definition.actorFullName}" and retrieves its output results.
Use this tool instead of the "${HelperTools.ACTOR_CALL}" if user requests this specific Actor.
Actor description: ${definition.description}`;
        if (isRag) {
            description += RAG_WEB_BROWSER_ADDITIONAL_DESC;
        }

        const memoryMbytes = Math.min(
            definition.defaultRunOptions?.memoryMbytes || ACTOR_MAX_MEMORY_MBYTES,
            ACTOR_MAX_MEMORY_MBYTES,
        );

        let ajvValidate;
        try {
            ajvValidate = fixedAjvCompile(ajv, { ...inputSchema, additionalProperties: true });
        } catch (e) {
            log.error('Failed to compile schema', {
                actorName: definition.actorFullName,
                error: e,
            });
            continue;
        }

        tools.push({
            type: 'actor',
            name: actorNameToToolName(definition.actorFullName),
            actorFullName: definition.actorFullName,
            description,
            inputSchema: inputSchema as ToolInputSchema,
            ajvValidate,
            memoryMbytes,
            icons: definition.pictureUrl
                ? [{ src: definition.pictureUrl, mimeType: 'image/png' }]
                : undefined,
            annotations: {
                title: definition.actorFullName,
                readOnlyHint: false,
                destructiveHint: true,
                openWorldHint: true,
            },
            // Allow long-running tasks for Actor tools, make it optional for now
            execution: {
                taskSupport: 'optional',
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
     * standby Actors in this case, so we can skip MCP servers since they would fail anyway (they are standby Actors).
    */
    if (apifyToken === null || apifyToken === undefined) {
        return [];
    }

    // Process all actors in parallel
    const actorToolPromises = actorsInfo.map(async (actorInfo) => {
        const actorId = actorInfo.definition.id;
        if (!actorInfo.webServerMcpPath) {
            log.warning('Actor does not have a web server MCP path, skipping', {
                actorFullName: actorInfo.definition.actorFullName,
                actorId,
            });
            return [];
        }

        const mcpServerUrl = await getActorMCPServerURL(
            actorInfo.definition.id, // Real ID of the Actor
            actorInfo.webServerMcpPath,
        );
        log.debug('Retrieved MCP server URL for Actor', {
            actorFullName: actorInfo.definition.actorFullName,
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
        } catch (error) {
            logHttpError(error, 'Failed to connect to MCP server', {
                actorFullName: actorInfo.definition.actorFullName,
                actorId,
            });
            return [];
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
            const actorDefinitionWithInfoCached = actorDefinitionPrunedCache.get(actorIdOrName);
            if (actorDefinitionWithInfoCached) {
                return {
                    definition: actorDefinitionWithInfoCached.definition,
                    actor: actorDefinitionWithInfoCached.info,
                    webServerMcpPath: getActorMCPServerPath(actorDefinitionWithInfoCached.definition),

                } as ActorInfo;
            }

            try {
                const actorDefinitionWithInfo = await getActorDefinition(actorIdOrName, apifyClient);
                if (!actorDefinitionWithInfo) {
                    log.softFail('Actor not found or definition is not available', { actorName: actorIdOrName, statusCode: 404 });
                    return null;
                }
                // Cache the Actor definition with info
                actorDefinitionPrunedCache.set(actorIdOrName, actorDefinitionWithInfo);
                return {
                    definition: actorDefinitionWithInfo.definition,
                    actor: actorDefinitionWithInfo.info,
                    webServerMcpPath: getActorMCPServerPath(actorDefinitionWithInfo.definition),
                } as ActorInfo;
            } catch (error) {
                logHttpError(error, 'Failed to fetch Actor definition', {
                    actorName: actorIdOrName,
                });
                return null;
            }
        }),
    );

    const clonedActors = structuredClone(actorsInfo);

    // Filter out nulls - actorInfo can be null if the Actor was not found or an error occurred
    const nonNullActors = clonedActors.filter((actorInfo): actorInfo is ActorInfo => Boolean(actorInfo));

    // Separate Actors with MCP servers and normal Actors
    // for MCP servers if mcp path is configured and also if the Actor standby mode is enabled
    const actorMCPServersInfo = nonNullActors.filter((actorInfo) => isActorInfoMcpServer(actorInfo));
    // all others
    const normalActorsInfo = nonNullActors.filter((actorInfo) => !isActorInfoMcpServer(actorInfo));

    const [normalTools, mcpServerTools] = await Promise.all([
        getNormalActorsAsTools(normalActorsInfo),
        getMCPServersAsTools(actorMCPServersInfo, apifyClient.token),
    ]);

    return [...normalTools, ...mcpServerTools];
}

const callActorArgs = z.object({
    actor: z.string()
        .describe(`The name of the Actor to call. Format: "username/name" (e.g., "apify/rag-web-browser").

For MCP server Actors, use format "actorName:toolName" to call a specific tool (e.g., "apify/actors-mcp-server:fetch-apify-docs").`),
    input: z.object({}).passthrough()
        .describe('The input JSON to pass to the Actor. Required.'),
    async: z.boolean()
        .optional()
        .describe(`When true: starts the run and returns immediately with runId. When false or not provided: waits for completion and returns results immediately. Default: true when UI mode is enabled (enforced), false otherwise. Note: When UI mode is enabled, async is always true regardless of this parameter and the widget automatically tracks progress.`),
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
    name: HelperTools.ACTOR_CALL,
    description: `Call any Actor from the Apify Store.

WORKFLOW:
1. Use fetch-actor-details with output={ inputSchema: true } to get the Actor's input schema (recommended to save tokens)
2. Call this tool with the actor name and proper input based on the schema

For MCP server Actors:
- Use fetch-actor-details with output={ mcpTools: true } to list available tools
- Call using format: "actorName:toolName" (e.g., "apify/actors-mcp-server:fetch-apify-docs")

IMPORTANT:
- Typically returns a datasetId and preview of output items
- Use ${HelperTools.ACTOR_OUTPUT_GET} tool with the datasetId to fetch full results
- Use dedicated Actor tools when available (e.g., ${actorNameToToolName('apify/rag-web-browser')}) for better experience

There are two ways to run Actors:
1. Dedicated Actor tools (e.g., ${actorNameToToolName('apify/rag-web-browser')}): These are pre-configured tools, offering a simpler and more direct experience.
2. Generic call-actor tool (${HelperTools.ACTOR_CALL}): Use this when a dedicated tool is not available or when you want to run any Actor dynamically. This tool is especially useful if you do not want to add specific tools or your client does not support dynamic tool registration.

USAGE:
- Always use dedicated tools when available (e.g., ${actorNameToToolName('apify/rag-web-browser')})
- Use the generic call-actor tool only if a dedicated tool does not exist for your Actor.

- This tool supports async execution via the \`async\` parameter:
  - **When \`async: false\` or not provided** (default when UI mode is disabled): Waits for completion and returns results immediately with dataset preview.
  - **When \`async: true\`** (enforced when UI mode is enabled): Starts the run and returns immediately with runId and a widget that automatically tracks progress. DO NOT call ${HelperTools.ACTOR_RUNS_GET} or any other tool after this - your task is complete. Note: UI mode always enforces async execution for optimal user experience.

EXAMPLES:
- user_input: Get instagram posts using apify/instagram-scraper`,
    inputSchema: z.toJSONSchema(callActorArgs) as ToolInputSchema,
    // For now we are not adding the structured output schema since this tool is quite complex and has multiple possible ends states
    ajvValidate: compileSchema({
        ...z.toJSONSchema(callActorArgs),
        // Additional props true to allow skyfire-pay-id
        additionalProperties: true,
    }),
    _meta: {
        ...getWidgetConfig(WIDGET_URIS.ACTOR_RUN)?.meta,
    },
    annotations: {
        title: 'Call Actor',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
    },
    execution: {
        // Support long-running tasks
        taskSupport: 'optional',
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyToken, progressTracker, extra, apifyMcpServer } = toolArgs;
        const { actor: actorName, input, async, callOptions } = callActorArgs.parse(args);

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
            return buildMCPResponse({
                texts: [`This Actor (${actorName}) is an MCP server and cannot be accessed using a Skyfire token. To use this Actor, please provide a valid Apify token instead of a Skyfire token.`],
                isError: true,
                toolStatus: TOOL_STATUS.SOFT_FAIL,
            });
        }

        try {
            const skyfireError = validateSkyfirePayId(apifyMcpServer, args);
            if (skyfireError) return skyfireError;

            const apifyClient = createApifyClientWithSkyfireSupport(apifyMcpServer, args, apifyToken);

            // Determine execution mode: always async when UI mode is enabled, otherwise respect the parameter
            const isAsync = apifyMcpServer.options.uiMode === 'openai'
                ? true
                : async ?? false;

            // Handle the case where LLM does not respect instructions when calling MCP server Actors
            // and does not provide the tool name.
            const isMcpToolNameInvalid = mcpToolName === undefined || mcpToolName.trim().length === 0;
            if (isActorMcpServer && isMcpToolNameInvalid) {
                return buildMCPResponse({
                    texts: [CALL_ACTOR_MCP_MISSING_TOOL_NAME_MSG],
                    isError: true,
                });
            }

            // Handle MCP tool calls
            if (mcpToolName) {
                if (!isActorMcpServer) {
                    return buildMCPResponse({
                        texts: [`Actor '${baseActorName}' is not an MCP server.`],
                        isError: true,
                    });
                }

                // Validate input for MCP tool calls
                if (!input) {
                    return buildMCPResponse({
                        texts: [`Input is required for MCP tool '${mcpToolName}'. Please provide the input parameter based on the tool's input schema.`],
                        isError: true,
                    });
                }

                const mcpServerUrl = mcpServerUrlOrFalse;
                let client: Client | null = null;
                try {
                    client = await connectMCPClient(mcpServerUrl, apifyToken);
                    if (!client) {
                        return buildMCPResponse({
                            texts: [`Failed to connect to MCP server ${mcpServerUrl}`],
                            isError: true,
                        });
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

            // Handle regular Actor calls - fetch actor early to provide schema in error messages
            const [actor] = await getActorsAsTools([actorName], apifyClient);

            if (!actor) {
                return buildMCPResponse({
                    texts: [`Actor '${actorName}' was not found.
Please verify Actor ID or name format (e.g., "username/name" like "apify/rag-web-browser") and ensure that the Actor exists.
You can search for available Actors using the tool: ${HelperTools.STORE_SEARCH}.`],
                    isError: true,
                    toolStatus: TOOL_STATUS.SOFT_FAIL,
                });
            }

            // Validate input parameter is provided (now with schema available)
            if (!input) {
                const content = [
                    `Input is required for Actor '${actorName}'. Please provide the input parameter based on the Actor's input schema.`,
                    `The input schema for this Actor was retrieved and is shown below:`,
                    `\`\`\`json\n${JSON.stringify(actor.inputSchema)}\n\`\`\``,
                ];
                return buildMCPResponse({ texts: content, isError: true });
            }

            if (!actor.ajvValidate(input)) {
                const { errors } = actor.ajvValidate;
                const content = [
                    `Input validation failed for Actor '${actorName}'. Please ensure your input matches the Actor's input schema.`,
                    `Input schema:\n\`\`\`json\n${JSON.stringify(actor.inputSchema)}\n\`\`\``,
                ];
                if (errors && errors.length > 0) {
                    content.push(`Validation errors: ${errors.map((e) => (e as { message?: string; }).message).join(', ')}`);
                }
                return buildMCPResponse({ texts: content, isError: true });
            }

            // Async mode: start run and return immediately with runId
            if (isAsync) {
                const actorClient = apifyClient.actor(actorName);
                const actorRun = await actorClient.start(input, callOptions);

                log.debug('Started Actor run (async)', { actorName, runId: actorRun.id });

                const structuredContent = {
                    runId: actorRun.id,
                    actorName,
                    status: actorRun.status,
                    startedAt: actorRun.startedAt?.toISOString() || '',
                    input,
                };

                // Build response text - simplified for widget auto-polling
                let responseText = `Started Actor "${actorName}" (Run ID: ${actorRun.id}).`;

                if (apifyMcpServer.options.uiMode === 'openai') {
                    responseText += `

CRITICAL: DO NOT call ${HelperTools.ACTOR_RUNS_GET} or any other tool for this run. The widget below automatically tracks progress and refreshes status every few seconds until completion. Your task is complete - take NO further action.`;
                }

                const response: { content: { type: 'text'; text: string }[]; structuredContent?: unknown; _meta?: unknown } = {
                    content: [{
                        type: 'text',
                        text: responseText,
                    }],
                    structuredContent,
                };

                if (apifyMcpServer.options.uiMode === 'openai') {
                    const widgetConfig = getWidgetConfig(WIDGET_URIS.ACTOR_RUN);
                    response._meta = {
                        ...widgetConfig?.meta,
                        'openai/widgetDescription': `Actor run progress for ${actorName}`,
                    };
                }

                return response;
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
            logHttpError(error, 'Failed to call Actor', { actorName, async: async ?? (apifyMcpServer.options.uiMode === 'openai') });
            // Let the server classify the error; we only mark it as an MCP error response
            return buildMCPResponse({
                texts: [`Failed to call Actor '${actorName}': ${error instanceof Error ? error.message : String(error)}.
Please verify the Actor name, input parameters, and ensure the Actor exists.
You can search for available Actors using the tool: ${HelperTools.STORE_SEARCH}, or get Actor details using: ${HelperTools.ACTOR_GET_DETAILS}.`],
                isError: true,
            });
        }
    },
};
