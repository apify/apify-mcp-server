import log from '@apify/log';

import { HelperTools } from '../../const.js';
import type { InternalToolArgs, ToolEntry } from '../../types.js';
import { buildUsageMeta } from '../../utils/mcp.js';
import { extractActorId } from '../../utils/tools.js';
import { callActorGetDataset } from '../core/actor_execution.js';
import { buildActorResponseContent } from '../core/actor_response.js';
import {
    buildCallActorDescription,
    buildCallActorErrorResponse,
    buildStartAsyncResponse,
    callActorAjvValidate,
    callActorInputSchema,
    callActorPreExecute,
    resolveAndValidateActor,
} from '../core/call_actor_common.js';
import { callActorOutputSchema } from '../structured_output_schemas.js';

const CALL_ACTOR_DEFAULT_DESCRIPTION = buildCallActorDescription({
    actorGetDetailsTool: HelperTools.ACTOR_GET_DETAILS,
    alwaysAsync: false,
});

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
    paymentRequired: true,
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
        const preResult = await callActorPreExecute(toolArgs, { route: HelperTools.ACTOR_CALL });
        if ('earlyResponse' in preResult) {
            return preResult.earlyResponse;
        }

        const { parsed, baseActorName } = preResult;
        const { input, async: isAsync = false, previewOutput = true, callOptions } = parsed;

        let resolvedActorId: string | undefined;
        try {
            const resolution = await resolveAndValidateActor({
                actorName: baseActorName,
                input: input as Record<string, unknown>,
                toolArgs,
            });
            if ('error' in resolution) {
                return resolution.error;
            }

            resolvedActorId = extractActorId(resolution.actor);
            const { apifyClient } = toolArgs;

            // Async mode: start run and return immediately with runId
            if (isAsync) {
                const actorClient = apifyClient.actor(baseActorName);
                const actorRun = await actorClient.start(input, callOptions);
                log.debug('Started Actor run (async)', { actorName: baseActorName, runId: actorRun.id, mcpSessionId: toolArgs.mcpSessionId });
                const response = buildStartAsyncResponse({
                    actorName: baseActorName,
                    actorRun,
                    input,
                    widget: false,
                });

                return {
                    ...response,
                    toolTelemetry: { actorId: resolvedActorId },
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
                toolTelemetry: { actorId: resolvedActorId },
            };
        } catch (error) {
            return buildCallActorErrorResponse({
                actorName: baseActorName,
                error,
                actorId: resolvedActorId,
                isAsync,
                mcpSessionId: toolArgs.mcpSessionId,
                actorGetDetailsTool: HelperTools.ACTOR_GET_DETAILS,
            });
        }
    },
} as const);
