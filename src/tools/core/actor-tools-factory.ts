import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import log from '@apify/log';

import type { ApifyClient } from '../../apify-client.js';
import {
    ACTOR_MAX_MEMORY_MBYTES,
    HelperTools,
    RAG_WEB_BROWSER,
    RAG_WEB_BROWSER_ADDITIONAL_DESC,
} from '../../const.js';
import { getActorMCPServerPath, getActorMCPServerURL } from '../../mcp/actors.js';
import { connectMCPClient } from '../../mcp/client.js';
import { getMCPServerTools } from '../../mcp/proxy.js';
import { actorDefinitionPrunedCache } from '../../state.js';
import type {
    ActorInfo,
    ActorStore,
    ActorTool,
    ApifyToken,
    ToolEntry,
    ToolInputSchema,
} from '../../types.js';
import { ajv } from '../../utils/ajv.js';
import { logHttpError } from '../../utils/logging.js';
import { getActorDefinition } from '../build.js';
import { buildEnrichedCallActorOutputSchema, callActorOutputSchema } from '../structured-output-schemas.js';
import { actorNameToToolName, buildActorInputSchema, fixedAjvCompile, isActorInfoMcpServer } from '../utils.js';

/**
 * Enriches actor tool output schemas with field-level detail from the ActorStore.
 * Uses Promise.allSettled to ensure individual failures don't block other tools.
 */
async function enrichActorToolOutputSchemas(tools: ToolEntry[], actorStore: ActorStore): Promise<void> {
    const enrichPromises = tools
        .filter((tool): tool is ActorTool => tool.type === 'actor')
        .map(async (tool) => {
            try {
                const itemProperties = await actorStore.getActorOutputSchema(tool.actorFullName);
                if (itemProperties && Object.keys(itemProperties).length > 0) {
                    // eslint-disable-next-line no-param-reassign
                    tool.outputSchema = buildEnrichedCallActorOutputSchema(itemProperties);
                }
            } catch (error) {
                log.debug('Failed to enrich output schema for Actor', {
                    actorName: tool.actorFullName,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        });

    await Promise.allSettled(enrichPromises);
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
    options?: { mcpSessionId?: string; actorStore?: ActorStore },
): Promise<ToolEntry[]> {
    const { mcpSessionId, actorStore } = options ?? {};
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
                mcpSessionId,
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
            // reuse the common output schema
            outputSchema: callActorOutputSchema,
            ajvValidate,
            requiresSkyfirePayId: true,
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

    // Enrich output schemas with field-level detail if actorStore is available
    if (actorStore) {
        await enrichActorToolOutputSchemas(tools, actorStore);
    }

    return tools;
}

async function getMCPServersAsTools(
    actorsInfo: ActorInfo[],
    apifyToken: ApifyToken,
    mcpSessionId?: string,
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
                mcpSessionId,
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
            mcpSessionId,
        });

        let client: Client | null = null;
        try {
            client = await connectMCPClient(mcpServerUrl, apifyToken, mcpSessionId);
            if (!client) {
                // Skip this Actor, connectMCPClient will log the error
                return [];
            }
            return await getMCPServerTools(actorId, client, mcpServerUrl);
        } catch (error) {
            logHttpError(error, 'Failed to load tools from MCP server', {
                actorFullName: actorInfo.definition.actorFullName,
                actorId,
                mcpSessionId,
            });
            return [];
        } finally {
            if (client) await client.close();
        }
    });

    // Wait for all actors to be processed in parallel
    const actorToolsArrays = await Promise.all(actorToolPromises);
    return actorToolsArrays.flat();
}

export async function getActorsAsTools(
    actorIdsOrNames: string[],
    apifyClient: ApifyClient,
    options?: { mcpSessionId?: string; actorStore?: ActorStore },
): Promise<ToolEntry[]> {
    const { mcpSessionId, actorStore } = options ?? {};
    log.debug('Fetching Actors as tools', { actorNames: actorIdsOrNames, mcpSessionId });

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
                    log.softFail('Actor not found or definition is not available', { actorName: actorIdOrName, mcpSessionId, statusCode: 404 });
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
                    mcpSessionId,
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
        getNormalActorsAsTools(normalActorsInfo, { mcpSessionId, actorStore }),
        getMCPServersAsTools(actorMCPServersInfo, apifyClient.token, mcpSessionId),
    ]);

    return [...normalTools, ...mcpServerTools];
}
