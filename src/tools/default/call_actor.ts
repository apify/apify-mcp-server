import log from '@apify/log';

import { HelperTools } from '../../const.js';
import type { InternalToolArgs, ToolEntry } from '../../types.js';
import { extractActorId } from '../../utils/tools.js';
import { fetchActorRunData } from '../core/actor_run_response.js';
import {
    buildCallActorDescription,
    buildCallActorErrorResponse,
    CALL_ACTOR_WAIT_SECS_DEFAULT,
    callActorAjvValidate,
    callActorInputSchema,
    callActorPreExecute,
    resolveAndValidateActor,
} from '../core/call_actor_common.js';
import { buildGetActorRunSuccessResponse } from '../core/get_actor_run_common.js';
import { getActorRunOutputSchema } from '../structured_output_schemas.js';

const CALL_ACTOR_DEFAULT_DESCRIPTION = buildCallActorDescription({
    actorGetDetailsTool: HelperTools.ACTOR_GET_DETAILS,
    alwaysAsync: false,
});

/**
 * Default mode call-actor tool.
 * Waits up to waitSecs (default 30) for completion and returns the run response.
 */
export const defaultCallActor: ToolEntry = Object.freeze({
    type: 'internal',
    name: HelperTools.ACTOR_CALL,
    description: CALL_ACTOR_DEFAULT_DESCRIPTION,
    inputSchema: callActorInputSchema,
    outputSchema: getActorRunOutputSchema,
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
        const { input, callOptions } = parsed;
        const waitSecs = parsed.waitSecs ?? CALL_ACTOR_WAIT_SECS_DEFAULT;

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
            const abortSignal = toolArgs.extra.signal;

            if (abortSignal?.aborted) return {};

            const actorRun = await apifyClient.actor(baseActorName).start(input, callOptions);
            log.debug('Started Actor run', { actorName: baseActorName, runId: actorRun.id, mcpSessionId: toolArgs.mcpSessionId, waitSecs });

            // Abort can arrive while start() was in flight — abort the newly created run.
            if (abortSignal?.aborted) {
                await apifyClient.run(actorRun.id).abort({ gracefully: false }).catch(() => undefined);
                return {};
            }

            const fetchResult = await fetchActorRunData({
                runId: actorRun.id,
                waitSecs,
                actorName: baseActorName,
                client: apifyClient,
                progressTracker: toolArgs.progressTracker,
                abortSignal,
                mcpSessionId: toolArgs.mcpSessionId,
                onAbort: async (runId, client) => {
                    await client.run(runId).abort({ gracefully: false }).catch(() => undefined);
                },
            });

            if ('aborted' in fetchResult) return {};
            if ('error' in fetchResult) return fetchResult.error;

            return {
                ...buildGetActorRunSuccessResponse({ ...fetchResult.result, widget: false }),
                toolTelemetry: { actorId: resolvedActorId },
            };
        } catch (error) {
            return buildCallActorErrorResponse({
                actorName: baseActorName,
                error,
                actorId: resolvedActorId,
                mcpSessionId: toolArgs.mcpSessionId,
                actorGetDetailsTool: HelperTools.ACTOR_GET_DETAILS,
            });
        }
    },
} as const);
