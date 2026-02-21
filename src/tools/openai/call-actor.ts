import log from '@apify/log';

import { createApifyClientWithSkyfireSupport } from '../../apify-client.js';
import { HelperTools } from '../../const.js';
import { getWidgetConfig, WIDGET_URIS } from '../../resources/widgets.js';
import type { InternalToolArgs, ToolEntry } from '../../types.js';
import { logHttpError } from '../../utils/logging.js';
import { buildMCPResponse } from '../../utils/mcp.js';
import {
    callActorAjvValidate,
    callActorInputSchema,
    callActorPreExecute,
    resolveAndValidateActor,
} from '../core/call-actor-common.js';
import { callActorOutputSchema } from '../structured-output-schemas.js';
import { actorNameToToolName } from '../utils.js';

const CALL_ACTOR_OPENAI_DESCRIPTION = `Call any Actor from the Apify Store.

WORKFLOW:
1. Use ${HelperTools.ACTOR_GET_DETAILS_INTERNAL} to get the Actor's input schema
2. Call this tool with the actor name and proper input based on the schema

If the actor name is not in "username/name" format, use ${HelperTools.STORE_SEARCH_INTERNAL} to resolve the correct Actor first.
Do NOT use ${HelperTools.STORE_SEARCH} for name resolution when the next step is running an Actor.

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
 * OpenAI mode call-actor tool.
 * Always runs asynchronously — starts the run and returns immediately with widget metadata.
 * The widget automatically tracks progress and updates the UI.
 */
export const openaiCallActor: ToolEntry = Object.freeze({
    type: 'internal',
    name: HelperTools.ACTOR_CALL,
    description: CALL_ACTOR_OPENAI_DESCRIPTION,
    inputSchema: callActorInputSchema,
    outputSchema: callActorOutputSchema,
    ajvValidate: callActorAjvValidate,
    requiresSkyfirePayId: true,
    // openai-only tool; openai/* keys also stripped in non-openai mode by stripOpenAiMeta() in src/utils/tools.ts
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
        const { input, callOptions } = parsed;

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

            // OpenAI mode always runs asynchronously
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

            const responseText = `Started Actor "${baseActorName}" (Run ID: ${actorRun.id}).

A live progress widget has been rendered that automatically tracks this run and refreshes status every few seconds until completion.

The widget will update the context with run status and datasetId when the run completes. Once complete (or if the user requests results), use ${HelperTools.ACTOR_OUTPUT_GET} with the datasetId to retrieve the output.

Do NOT proactively poll using ${HelperTools.ACTOR_RUNS_GET}. Wait for the widget state update or user instructions. Ask the user what they would like to do next.`;

            const widgetConfig = getWidgetConfig(WIDGET_URIS.ACTOR_RUN);
            return {
                content: [{
                    type: 'text',
                    text: responseText,
                }],
                structuredContent,
                // Response-level meta; only returned in openai mode (this handler is openai-only)
                _meta: {
                    ...widgetConfig?.meta,
                    'openai/widgetDescription': `Actor run progress for ${baseActorName}`,
                },
            };
        } catch (error) {
            logHttpError(error, 'Failed to call Actor', { actorName: baseActorName, async: true });
            return buildMCPResponse({
                texts: [`Failed to call Actor '${baseActorName}': ${error instanceof Error ? error.message : String(error)}.
Please verify the Actor name, input parameters, and ensure the Actor exists.
You can search for available Actors using the tool: ${HelperTools.STORE_SEARCH}, or get Actor details using: ${HelperTools.ACTOR_GET_DETAILS}.`],
                isError: true,
            });
        }
    },
} as const);
