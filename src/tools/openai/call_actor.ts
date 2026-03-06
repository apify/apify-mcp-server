import log from '@apify/log';

import { createApifyClientWithSkyfireSupport } from '../../apify_client.js';
import { HelperTools } from '../../const.js';
import { getWidgetConfig, WIDGET_URIS } from '../../resources/widgets.js';
import type { InternalToolArgs, ToolEntry } from '../../types.js';
import { logHttpError } from '../../utils/logging.js';
import { buildMCPResponse } from '../../utils/mcp.js';
import {
    CALL_ACTOR_EXAMPLES_SECTION,
    CALL_ACTOR_MCP_SERVER_SECTION,
    CALL_ACTOR_USAGE_SECTION,
    callActorAjvValidate,
    callActorInputSchema,
    callActorPreExecute,
    resolveAndValidateActor,
} from '../core/call_actor_common.js';
import { callActorOutputSchema } from '../structured_output_schemas.js';

const CALL_ACTOR_OPENAI_DESCRIPTION = [
    `Call any Actor from the Apify Store.`,

    `WORKFLOW:
1. Use ${HelperTools.ACTOR_GET_DETAILS_INTERNAL} to get the Actor's input schema
2. Call this tool with the actor name and proper input based on the schema

If the actor name is not in "username/name" format, use ${HelperTools.STORE_SEARCH_INTERNAL} to resolve the correct Actor first.
Do NOT use ${HelperTools.STORE_SEARCH} for name resolution when the next step is running an Actor.`,

    CALL_ACTOR_MCP_SERVER_SECTION,

    `IMPORTANT:
- This tool always runs asynchronously — it starts the Actor and returns immediately with a runId. A live widget automatically tracks the run progress.
- After calling this tool, do NOT poll or call any other tool. Wait for the user to respond — the widget will update them when the run completes.
- Once the run completes, use ${HelperTools.ACTOR_OUTPUT_GET} tool with the datasetId to fetch full results.
- Use dedicated Actor tools when available for better experience`,

    CALL_ACTOR_USAGE_SECTION,

    CALL_ACTOR_EXAMPLES_SECTION,
].join('\n\n');

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
    // openai-only tool; openai/* and ui keys also stripped in non-openai mode by stripWidgetMeta() in src/utils/tools.ts
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
            // Let the server classify the error; we only mark it as an MCP error response
            return buildMCPResponse({
                texts: [`Failed to call Actor '${baseActorName}': ${error instanceof Error ? error.message : String(error)}.
Please verify the Actor name, input parameters, and ensure the Actor exists.
You can search for available Actors using the tool: ${HelperTools.STORE_SEARCH_INTERNAL}, or get Actor details using: ${HelperTools.ACTOR_GET_DETAILS_INTERNAL}.`],
                isError: true,
            });
        }
    },
} as const);
