import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { z } from 'zod';

import log from '@apify/log';

import { ApifyClient, createApifyClientWithSkyfireSupport } from '../apify-client.js';
import {
    CALL_ACTOR_MCP_MISSING_TOOL_NAME_MSG,
    HelperTools,
    TOOL_STATUS,
} from '../const.js';
import { connectMCPClient } from '../mcp/client.js';
import { getWidgetConfig, WIDGET_URIS } from '../resources/widgets.js';
import type {
    InternalToolArgs,
    ToolEntry,
    ToolInputSchema,
    UiMode,
} from '../types.js';
import { getActorMcpUrlCached } from '../utils/actor.js';
import { compileSchema } from '../utils/ajv.js';
import { logHttpError } from '../utils/logging.js';
import { buildMCPResponse, buildUsageMeta } from '../utils/mcp.js';
import { callActorGetDataset } from './core/actor-execution.js';
import { buildActorResponseContent } from './core/actor-response.js';
import { getActorsAsTools } from './core/actor-tools-factory.js';
import { callActorOutputSchema } from './structured-output-schemas.js';
import { actorNameToToolName } from './utils.js';

// Re-exports to maintain backward compatibility and support other modules
export { callActorGetDataset, type CallActorGetDatasetResult } from './core/actor-execution.js';
export { getActorsAsTools } from './core/actor-tools-factory.js';

const callActorArgs = z.object({
    actor: z.string()
        .describe(`The name of the Actor to call. Format: "username/name" (e.g., "apify/rag-web-browser").

For MCP server Actors, use format "actorName:toolName" to call a specific tool (e.g., "apify/actors-mcp-server:fetch-apify-docs").`),
    input: z.object({}).passthrough()
        .describe('The input JSON to pass to the Actor. Required.'),
    async: z.boolean()
        .optional()
        .describe(`When true: starts the run and returns immediately with runId. When false or not provided: waits for completion and returns results immediately. Default: true when UI mode is enabled (enforced), false otherwise. IMPORTANT: Only set async to true if the user explicitly asks to run the Actor in the background or does not need immediate results. When the user asks for data or results, always use async: false (default) so the results are returned immediately.`),
    previewOutput: z.boolean()
        .optional()
        .describe('When true (default): includes preview items. When false: metadata only (reduces context). Use when fetching fields via get-actor-output.'),
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

/**
 * This is a bit of a hacky way to deal with it, but let's use it for now
 */
export function getCallActorDescription(uiMode?: UiMode): string {
    const isUiMode = uiMode === 'openai';
    const schemaTool = isUiMode ? HelperTools.ACTOR_GET_DETAILS_INTERNAL : HelperTools.ACTOR_GET_DETAILS;
    const searchTool = isUiMode ? HelperTools.STORE_SEARCH_INTERNAL : HelperTools.STORE_SEARCH;
    const searchToolWarning = isUiMode
        ? `Do NOT use ${HelperTools.STORE_SEARCH} for name resolution when the next step is running an Actor.`
        : '';

    return `Call any Actor from the Apify Store.

WORKFLOW:
1. Use ${schemaTool} to get the Actor's input schema
2. Call this tool with the actor name and proper input based on the schema

If the actor name is not in "username/name" format, use ${searchTool} to resolve the correct Actor first.
${searchToolWarning}

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
  - **When \`async: false\` or not provided** (default): Waits for completion and returns results immediately with dataset preview. Use this whenever the user asks for data or results.
  - **When \`async: true\`**: Starts the run and returns immediately with runId. Only use this when the user explicitly asks to run the Actor in the background or does not need immediate results. When UI mode is enabled, async is always enforced and the widget automatically tracks progress.

EXAMPLES:
- user_input: Get instagram posts using apify/instagram-scraper`;
}

export const callActor: ToolEntry = {
    type: 'internal',
    name: HelperTools.ACTOR_CALL,
    description: getCallActorDescription(),
    inputSchema: z.toJSONSchema(callActorArgs) as ToolInputSchema,
    outputSchema: callActorOutputSchema,
    ajvValidate: compileSchema({
        ...z.toJSONSchema(callActorArgs),
        // Additional props true to allow skyfire-pay-id
        additionalProperties: true,
    }),
    requiresSkyfirePayId: true,
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
        const { args, apifyToken, progressTracker, extra, apifyMcpServer, mcpSessionId } = toolArgs;
        const { actor: actorName, input, async, previewOutput = true, callOptions } = callActorArgs.parse(args);

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
                    client = await connectMCPClient(mcpServerUrl, apifyToken, mcpSessionId);
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
                } catch (error) {
                    logHttpError(error, `Failed to call MCP tool '${mcpToolName}' on Actor '${baseActorName}'`, {
                        actorName: baseActorName,
                        toolName: mcpToolName,
                    });
                    return buildMCPResponse({
                        texts: [`Failed to call MCP tool '${mcpToolName}' on Actor '${baseActorName}': ${error instanceof Error ? error.message : String(error)}. The MCP server may be temporarily unavailable.`],
                        isError: true,
                    });
                } finally {
                    if (client) await client.close();
                }
            }

            const apifyClient = createApifyClientWithSkyfireSupport(apifyMcpServer, args, apifyToken);

            // Handle regular Actor calls - fetch actor early to provide schema in error messages
            const [actor] = await getActorsAsTools([actorName], apifyClient, { mcpSessionId });

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

                log.debug('Started Actor run (async)', { actorName, runId: actorRun.id, mcpSessionId });

                const structuredContent = {
                    runId: actorRun.id,
                    actorName, // Full name with username (e.g., "apify/rag-web-browser")
                    status: actorRun.status,
                    startedAt: actorRun.startedAt?.toISOString() || '',
                    input,
                };

                // Build response text - simplified for widget auto-polling
                let responseText = `Started Actor "${actorName}" (Run ID: ${actorRun.id}).`;

                if (apifyMcpServer.options.uiMode === 'openai') {
                    responseText += `

A live progress widget has been rendered that automatically tracks this run and refreshes status every few seconds until completion.

The widget will update the context with run status and datasetId when the run completes. Once complete (or if the user requests results), use ${HelperTools.ACTOR_OUTPUT_GET} with the datasetId to retrieve the output.

Do NOT proactively poll using ${HelperTools.ACTOR_RUNS_GET}. Wait for the widget state update or user instructions. Ask the user what they would like to do next.`;
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

            const callResult = await callActorGetDataset({
                actorName,
                input,
                apifyClient,
                callOptions,
                progressTracker,
                abortSignal: extra.signal,
                previewOutput,
                mcpSessionId,
            });

            if (!callResult) {
                // Receivers of cancellation notifications SHOULD NOT send a response for the cancelled request
                // https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation#behavior-requirements
                return {};
            }

            const { content, structuredContent } = buildActorResponseContent(actorName, callResult, previewOutput);

            const _meta = buildUsageMeta(callResult);
            return {
                content,
                structuredContent,
                ...(_meta && { _meta }),
            };
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
