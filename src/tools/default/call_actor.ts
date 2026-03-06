import log from '@apify/log';

import { createApifyClientWithSkyfireSupport } from '../../apify_client.js';
import { HelperTools } from '../../const.js';
import { getWidgetConfig, WIDGET_URIS } from '../../resources/widgets.js';
import type { InternalToolArgs, ToolEntry } from '../../types.js';
import { logHttpError } from '../../utils/logging.js';
import { buildMCPResponse, buildUsageMeta } from '../../utils/mcp.js';
import { callActorGetDataset } from '../core/actor_execution.js';
import { buildActorResponseContent } from '../core/actor_response.js';
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

const CALL_ACTOR_DEFAULT_DESCRIPTION = [
    `Call any Actor from the Apify Store.`,

    `WORKFLOW:
1. Use ${HelperTools.ACTOR_GET_DETAILS} to get the Actor's input schema
2. Call this tool with the actor name and proper input based on the schema

If the actor name is not in "username/name" format, use ${HelperTools.STORE_SEARCH} to resolve the correct Actor first.`,

    CALL_ACTOR_MCP_SERVER_SECTION,

    `IMPORTANT:
- Typically returns a datasetId and preview of output items
- Use ${HelperTools.ACTOR_OUTPUT_GET} tool with the datasetId to fetch full results
- Use dedicated Actor tools when available for better experience`,

    CALL_ACTOR_USAGE_SECTION,

    `- This tool supports async execution via the \`async\` parameter:
  - **When \`async: false\` or not provided** (default): Waits for completion and returns results immediately with dataset preview. Use this whenever the user asks for data or results.
  - **When \`async: true\`**: Starts the run and returns immediately with runId. Only use this when the user explicitly asks to run the Actor in the background or does not need immediate results.`,

    CALL_ACTOR_EXAMPLES_SECTION,
].join('\n\n');

/**
 * Default mode call-actor tool.
 * Supports both sync (default) and async execution.
 * Does not include widget metadata in responses.
 */
export const defaultCallActor: ToolEntry = Object.freeze({
    type: 'internal',
    name: HelperTools.ACTOR_CALL,
    description: CALL_ACTOR_DEFAULT_DESCRIPTION,
    inputSchema: callActorInputSchema,
    outputSchema: callActorOutputSchema,
    ajvValidate: callActorAjvValidate,
    requiresSkyfirePayId: true,
    // openai/* and ui keys are stripped in non-openai mode by stripWidgetMeta() in src/utils/tools.ts
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
                // Receivers of cancellation notifications SHOULD NOT send a response for the cancelled request
                // https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation#behavior-requirements
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
            // Let the server classify the error; we only mark it as an MCP error response
            return buildMCPResponse({
                texts: [`Failed to call Actor '${baseActorName}': ${error instanceof Error ? error.message : String(error)}.
Please verify the Actor name, input parameters, and ensure the Actor exists.
You can search for available Actors using the tool: ${HelperTools.STORE_SEARCH}, or get Actor details using: ${HelperTools.ACTOR_GET_DETAILS}.`],
                isError: true,
            });
        }
    },
} as const);
