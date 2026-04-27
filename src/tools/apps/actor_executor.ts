import log from '@apify/log';

import type { ActorExecutionParams, ActorExecutionResult, ActorExecutor } from '../../types.js';
import { buildStartAsyncResponse } from '../core/call_actor_common.js';

/**
 * Apps-mode actor executor.
 * Runs actors asynchronously — starts the run and returns immediately with widget metadata.
 * The widget automatically tracks progress and updates the UI.
 */
export const appsActorExecutor: ActorExecutor = {
    async executeActorTool(params: ActorExecutionParams): Promise<ActorExecutionResult> {
        if (params.abortSignal?.aborted) {
            return null;
        }

        const actorClient = params.apifyClient.actor(params.actorFullName);
        const actorRun = await actorClient.start(params.input, params.callOptions);

        log.debug('Started Actor run (async, direct actor tool)', {
            actorName: params.actorFullName,
            runId: actorRun.id,
            mcpSessionId: params.mcpSessionId,
        });

        return buildStartAsyncResponse({
            actorName: params.actorFullName,
            actorRun,
            input: params.input,
            widget: true,
        });
    },
};
