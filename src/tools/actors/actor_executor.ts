import log from '@apify/log';

import type { ActorExecutionParams, ActorExecutionResult, ActorExecutor } from '../../types.js';
import { getConsoleLinkContext } from '../../utils/console_link.js';
import { redactSkyfirePayId } from '../../utils/logging.js';
import { buildGetActorRunResponse } from '../runs/get_actor_run.js';
import { abortRunOnSignal, CALL_ACTOR_WAIT_SECS_DEFAULT, fetchActorRunData } from './actor_run_response.js';

/**
 * Direct actor tool executor. Mode-agnostic — used in both default and apps modes.
 * Returns the canonical `RunResponse` shape; dataset items are not inlined — the LLM
 * follows `nextStep` to `get-dataset-items`.
 *
 * Wait contract matches `call-actor`: default 30 s, max 45, task mode waits until terminal.
 */
export const actorExecutor: ActorExecutor = {
    async executeActorTool(params: ActorExecutionParams): Promise<ActorExecutionResult> {
        const { actorFullName, apifyClient, mcpSessionId, abortSignal, progressTracker, taskMode } = params;
        // Strip `waitSecs` from the Actor's input — it's an MCP-injected opt-in, not an
        // Actor field — so `actor.start()` doesn't reject or silently pass it through.
        const { waitSecs: argsWaitSecs, ...actorInput } = params.input as { waitSecs?: number } & Record<
            string,
            unknown
        >;
        // Task mode waits until terminal; honoring waitSecs would let the task complete
        // before the Actor produced output. Mirrors executeCallActor.
        // AJV doesn't fill `default` values, so apply the 30 s default here when the LLM omits waitSecs.
        const waitSecs = taskMode ? undefined : (argsWaitSecs ?? CALL_ACTOR_WAIT_SECS_DEFAULT);
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

        return buildGetActorRunResponse({
            ...fetchResult.result,
            linkContext: await getConsoleLinkContext(apifyClient.token, apifyClient),
        }) as ActorExecutionResult;
    },
};
