import { z } from 'zod';

import log from '@apify/log';

import { FAILURE_CATEGORY } from '../../const.js';
import type { ActorExecutionParams, ActorExecutionResult, ActorExecutor } from '../../types.js';
import { isActorInputValidationError } from '../../utils/apify_errors.js';
import { getConsoleLinkContext } from '../../utils/console_link.js';
import { buildInvalidInputTexts, respondUserError } from '../../utils/mcp.js';
import { buildGetActorRunResponse } from '../runs/get_actor_run.js';
import {
    abortRunOnSignal,
    CALL_ACTOR_WAIT_SECS_DEFAULT,
    fetchActorRunData,
    WAIT_SECS_MAX,
} from './actor_run_response.js';
import { buildDirectActorRunInput } from './actor_tool_contract.js';

// AJV coerces a numeric string on a validated schema; a schema that skips AJV gets the same here.
const waitSecsSchema = z
    .preprocess(
        (value) => (typeof value === 'string' && value.trim() !== '' ? Number(value) : value),
        z.number().int().min(0).max(WAIT_SECS_MAX),
    )
    .catch(CALL_ACTOR_WAIT_SECS_DEFAULT);

/**
 * Direct actor tool executor. Mode-agnostic — used in both default and apps modes.
 * Returns the canonical `RunResponse` shape; dataset items are not inlined — the LLM
 * follows `nextStep` to `get-dataset-items`.
 *
 * Wait contract matches `call-actor`: default 30 s, max 45, task mode waits until terminal.
 */
export const actorExecutor: ActorExecutor = {
    async executeActorTool(params: ActorExecutionParams): Promise<ActorExecutionResult> {
        const { actorFullName, apifyClient, mcpSessionId, abortSignal, progressTracker, taskMode, canRunTipActor } =
            params;
        // Strip `waitSecs` from the Actor's input — it's an MCP-injected opt-in, not an
        // Actor field — so `actor.start()` doesn't reject or silently pass it through.
        const { waitSecs: argsWaitSecs, ...actorInput } = params.input;
        // Task mode waits until terminal; honoring waitSecs would let the task complete
        // before the Actor produced output. Mirrors executeCallActor.
        // AJV doesn't fill `default` values, and it does not validate a schema that is costly to compile,
        // so an omitted or invalid waitSecs gets the 30 s default here.
        const waitSecs = taskMode ? undefined : waitSecsSchema.parse(argsWaitSecs);

        if (abortSignal?.aborted) {
            log.info('Actor run aborted by client before start', {
                actorName: actorFullName,
                mcpSessionId,
            });
            return null;
        }

        let actorRun;
        try {
            actorRun = await apifyClient
                .actor(actorFullName)
                .start(buildDirectActorRunInput(actorFullName, actorInput), params.callOptions);
        } catch (error) {
            // Platform can reject input our own AJV gate passed (see isActorInputValidationError).
            if (!isActorInputValidationError(error)) throw error;
            log.softFail('Actor input failed platform validation', {
                actorName: actorFullName,
                mcpSessionId,
                failureCategory: FAILURE_CATEGORY.INVALID_INPUT,
            });
            return respondUserError(buildInvalidInputTexts(actorFullName, error.message), {
                actorId: params.actorId,
                detail: error.message.slice(0, 200),
            }) as ActorExecutionResult;
        }

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
            canRunTipActor,
        }) as ActorExecutionResult;
    },
};
