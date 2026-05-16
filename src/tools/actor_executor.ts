import log from '@apify/log';

import type { ActorExecutionParams, ActorExecutionResult, ActorExecutor } from '../types.js';
import { redactSkyfirePayId } from '../utils/logging.js';
import { abortRunOnSignal, fetchActorRunData } from './core/actor_run_response.js';
import { buildGetActorRunSuccessResponse } from './core/get_actor_run_common.js';

/**
 * Direct actor tool executor. Mode-agnostic — used in both default and apps modes.
 * Returns the canonical `RunResponse` shape; dataset items are not inlined — the LLM
 * follows `nextStep` to `get-dataset-items`.
 *
 * `waitSecs` is an MCP-only opt-in: omit to wait until terminal (default), set 0–45 to cap.
 */
export const actorExecutor: ActorExecutor = {
    async executeActorTool(params: ActorExecutionParams): Promise<ActorExecutionResult> {
        const { actorFullName, apifyClient, mcpSessionId, abortSignal, progressTracker } = params;
        // Strip `waitSecs` from the Actor's input — it's an MCP-injected opt-in, not an
        // Actor field — so `actor.start()` doesn't reject or silently pass it through.
        const { waitSecs, ...actorInput } = params.input as { waitSecs?: number } & Record<string, unknown>;
        const redactedInput = redactSkyfirePayId(params.input);

        if (abortSignal?.aborted) {
            log.info('Actor run aborted by client before start', {
                actorName: actorFullName,
                mcpSessionId,
                input: redactedInput,
            });
            return null;
        }

        const actorRun = await apifyClient.actor(actorFullName).start(actorInput, params.callOptions);

        log.debug('Started Actor run (direct actor tool)', {
            actorName: actorFullName,
            runId: actorRun.id,
            mcpSessionId,
            waitSecs,
        });

        if (abortSignal?.aborted) {
            await abortRunOnSignal(actorRun.id, apifyClient);
            log.info('Actor run aborted by client', {
                actorName: actorFullName,
                mcpSessionId,
                runId: actorRun.id,
                input: redactedInput,
            });
            return null;
        }

        const fetchResult = await fetchActorRunData({
            runId: actorRun.id,
            waitSecs,
            actorName: actorFullName,
            client: apifyClient,
            progressTracker,
            abortSignal,
            mcpSessionId,
            onAbort: abortRunOnSignal,
        });

        if ('aborted' in fetchResult) {
            log.info('Actor run aborted by client', {
                actorName: actorFullName,
                mcpSessionId,
                runId: actorRun.id,
                input: redactedInput,
            });
            return null;
        }
        if ('error' in fetchResult) return fetchResult.error as ActorExecutionResult;

        // Mirror the tool's declared `itemsSchema` into the runtime response so the response
        // matches its outputSchema. Only direct actor tools know the row shape up front.
        const dataset = fetchResult.result.structuredContent.storages?.datasets?.default;
        if (dataset && params.datasetItemsSchema) {
            dataset.itemsSchema = { type: 'object', properties: params.datasetItemsSchema };
        }

        return buildGetActorRunSuccessResponse({ ...fetchResult.result, widget: false }) as ActorExecutionResult;
    },
};
