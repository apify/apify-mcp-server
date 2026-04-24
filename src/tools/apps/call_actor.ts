import log from '@apify/log';

import { HelperTools } from '../../const.js';
import type { InternalToolArgs, ToolEntry } from '../../types.js';
import { extractActorId } from '../../utils/tools.js';
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

const CALL_ACTOR_APPS_DESCRIPTION = buildCallActorDescription({
    actorGetDetailsTool: HelperTools.ACTOR_GET_DETAILS,
    alwaysAsync: true,
});

/**
 * Apps mode call-actor tool.
 * Always runs asynchronously — starts the run and returns immediately with runId.
 * Renders no widget; for a live progress UI, use the call-actor-widget sibling.
 */
export const appsCallActor: ToolEntry = Object.freeze({
    type: 'internal',
    name: HelperTools.ACTOR_CALL,
    description: CALL_ACTOR_APPS_DESCRIPTION,
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
    call: async (toolArgs: InternalToolArgs) => {
        const preResult = await callActorPreExecute(toolArgs, { route: HelperTools.ACTOR_CALL });
        if ('earlyResponse' in preResult) {
            return preResult.earlyResponse;
        }

        const { parsed, baseActorName } = preResult;
        const { input, callOptions } = parsed;

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

            // Apps mode always runs asynchronously
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
        } catch (error) {
            return buildCallActorErrorResponse({
                actorName: baseActorName,
                error,
                actorId: resolvedActorId,
                isAsync: true,
                mcpSessionId: toolArgs.mcpSessionId,
                actorGetDetailsTool: HelperTools.ACTOR_GET_DETAILS,
            });
        }
    },
} as const);
