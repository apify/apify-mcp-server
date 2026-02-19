import log from '@apify/log';

import { createApifyClientWithSkyfireSupport } from '../../apify-client.js';
import { HelperTools } from '../../const.js';
import { getWidgetConfig, WIDGET_URIS } from '../../resources/widgets.js';
import type { InternalToolArgs, ToolEntry } from '../../types.js';
import { logHttpError } from '../../utils/logging.js';
import { buildMCPResponse, buildUsageMeta } from '../../utils/mcp.js';
import { callActorGetDataset } from '../core/actor-execution.js';
import { buildActorResponseContent } from '../core/actor-response.js';
import {
    callActorAjvValidate,
    callActorInputSchema,
    callActorPreExecute,
    resolveAndValidateActor,
} from '../core/call-actor-common.js';
import { callActorOutputSchema } from '../structured-output-schemas.js';
import { actorNameToToolName } from '../utils.js';

const CALL_ACTOR_DEFAULT_DESCRIPTION = `Call any Actor from the Apify Store.

WORKFLOW:
1. Use ${HelperTools.ACTOR_GET_DETAILS} to get the Actor's input schema
2. Call this tool with the actor name and proper input based on the schema

If the actor name is not in "username/name" format, use ${HelperTools.STORE_SEARCH} to resolve the correct Actor first.

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

/**
 * Default mode call-actor tool.
 * Supports both sync (default) and async execution.
 * Does not include widget metadata in responses.
 */
export const defaultCallActor: ToolEntry = {
    type: 'internal',
    name: HelperTools.ACTOR_CALL,
    description: CALL_ACTOR_DEFAULT_DESCRIPTION,
    inputSchema: callActorInputSchema,
    outputSchema: callActorOutputSchema,
    ajvValidate: callActorAjvValidate,
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
        taskSupport: 'optional',
    },
    call: async (toolArgs: InternalToolArgs) => {
        const preResult = await callActorPreExecute(toolArgs);
        if ('earlyResponse' in preResult) {
            return preResult.earlyResponse;
        }

        const { parsed, baseActorName } = preResult;
        const { input, async: isAsync = false, previewOutput = true, callOptions } = parsed;

        try {
            const resolution = await resolveAndValidateActor({
                actorName: baseActorName,
                input: input as Record<string, unknown>,
                toolArgs,
            });
            if ('error' in resolution) {
                return resolution.error;
            }

            const apifyClient = createApifyClientWithSkyfireSupport(toolArgs.apifyMcpServer, toolArgs.args, toolArgs.apifyToken);

            // Async mode: start run and return immediately with runId
            if (isAsync) {
                const actorClient = apifyClient.actor(baseActorName);
                const actorRun = await actorClient.start(input, callOptions);

                log.debug('Started Actor run (async)', { actorName: baseActorName, runId: actorRun.id, mcpSessionId: toolArgs.mcpSessionId });

                const structuredContent = {
                    runId: actorRun.id,
                    actorName: baseActorName,
                    status: actorRun.status,
                    startedAt: actorRun.startedAt?.toISOString() || '',
                    input,
                };

                return {
                    content: [{
                        type: 'text',
                        text: `Started Actor "${baseActorName}" (Run ID: ${actorRun.id}).`,
                    }],
                    structuredContent,
                };
            }

            // Sync mode: wait for completion and return results
            const callResult = await callActorGetDataset({
                actorName: baseActorName,
                input,
                apifyClient,
                callOptions,
                progressTracker: toolArgs.progressTracker,
                abortSignal: toolArgs.extra.signal,
                previewOutput,
                mcpSessionId: toolArgs.mcpSessionId,
            });

            if (!callResult) {
                return {};
            }

            const { content, structuredContent } = buildActorResponseContent(baseActorName, callResult, previewOutput);
            const _meta = buildUsageMeta(callResult);
            return {
                content,
                structuredContent,
                ...(_meta && { _meta }),
            };
        } catch (error) {
            logHttpError(error, 'Failed to call Actor', { actorName: baseActorName, async: isAsync });
            return buildMCPResponse({
                texts: [`Failed to call Actor '${baseActorName}': ${error instanceof Error ? error.message : String(error)}.
Please verify the Actor name, input parameters, and ensure the Actor exists.
You can search for available Actors using the tool: ${HelperTools.STORE_SEARCH}, or get Actor details using: ${HelperTools.ACTOR_GET_DETAILS}.`],
                isError: true,
            });
        }
    },
};
