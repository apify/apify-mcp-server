import dedent from 'dedent';
import { z } from 'zod';

import log from '@apify/log';

import { APIFY_CODE_RUNTIME_ACTOR, HELPER_TOOLS } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { getConsoleLinkContext } from '../../utils/console_link.js';
import { buildGetActorRunSuccessResponse } from '../runs/get_actor_run.js';
import { actorRunOutputSchema } from '../structured_output_schemas.js';
import {
    abortRunOnSignal,
    buildStartRunResponse,
    CALL_ACTOR_WAIT_SECS_DEFAULT,
    fetchActorRunData,
    WAIT_SECS_MAX,
} from './actor_run_response.js';
import { buildCallActorErrorResponse, callOptionsSchema } from './call_actor.js';

export const runCodeArgs = z.object({
    code: z
        .string()
        .min(1)
        .describe(`The JavaScript/TypeScript to run. Call ${HELPER_TOOLS.CODE_DOCS} to learn how to write it.`),
    waitSecs: z
        .number()
        .int()
        .min(0, 'waitSecs must be 0 or greater')
        .max(WAIT_SECS_MAX, `waitSecs cannot exceed ${WAIT_SECS_MAX}`)
        .default(CALL_ACTOR_WAIT_SECS_DEFAULT)
        .optional()
        .describe(
            `Seconds to wait for the run to finish. Range 0–${WAIT_SECS_MAX}; ${WAIT_SECS_MAX} is the MAXIMUM — values above ${WAIT_SECS_MAX} (e.g. 60) are rejected. Default ${CALL_ACTOR_WAIT_SECS_DEFAULT}. If the run isn't terminal within waitSecs, returns the current run status; use 0 to start and return immediately for long scripts.`,
        ),
    // code-runtime is a platform-usage Actor, so the pay-per-event / pay-per-result caps
    // (maxTotalChargeUsd, maxItems) are silently ignored by the platform — expose only the
    // options that actually apply. See PR #1044 for the removed cost cap.
    callOptions: callOptionsSchema
        .pick({ memory: true, timeout: true })
        .optional()
        .describe('Optional run config: memory (MB), timeout (s).'),
});

const runCodeInputSchema = z.toJSONSchema(runCodeArgs) as ToolInputSchema;

const RUN_CODE_DESCRIPTION = dedent`
    Run a JavaScript/TypeScript script in a sandboxed Apify Actor (${APIFY_CODE_RUNTIME_ACTOR}) with an
    \`apify\` binding (search/run Actors, read/write datasets and key-value stores), then return the run
    result. Limited permissions: no filesystem, no imports, outbound network limited to the apify.com
    domain and its subdomains (*.apify.com) only.

    USE THIS FIRST FOR ANY MULTI-STEP TASK. If the request needs 2+ Actor runs, feeds one Actor's output
    into another, or filters/transforms/joins/aggregates Actor results before answering, do it all in
    one script here — not as separate ${HELPER_TOOLS.ACTOR_CALL} / ${HELPER_TOOLS.DATASET_GET_ITEMS} calls.
    One script is faster, cheaper, and keeps large intermediate data out of the model context.

    OUTPUT: the script's { stdout, stderr, exitCode } is written to the run's default dataset; follow
    the nextStep and read it with ${HELPER_TOOLS.DATASET_GET_ITEMS} using the returned datasetId.
    exitCode is 0 on success, 1 if the script threw (check it, not stderr, to detect a failed script).

    WORKFLOW: (1) call ${HELPER_TOOLS.CODE_DOCS} (overview page) to learn the binding, and
    ${HELPER_TOOLS.ACTOR_GET_DETAILS} for each Actor you'll use to get its input/output schemas;
    (2) call this tool with your \`code\`.
`;

/**
 * Code Mode `run-code` — thin wrapper over the canonical call-actor start→wait→respond pipeline,
 * hardcoded to the ${APIFY_CODE_RUNTIME_ACTOR} Actor with `{ code }` as input.
 */
export const runCode: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.CODE_RUN,
    title: 'Run code',
    description: RUN_CODE_DESCRIPTION,
    inputSchema: runCodeInputSchema,
    outputSchema: actorRunOutputSchema,
    ajvValidate: compileSchema(runCodeInputSchema),
    paymentRequired: true,
    annotations: {
        title: 'Run code',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
    },
    execution: {
        // Scripts can orchestrate long-running Actors.
        taskSupport: 'optional',
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { apifyClient, apifyToken, args, extra, mcpSessionId, progressTracker, taskMode } = toolArgs;
        const parsed = runCodeArgs.parse(args);
        // Task mode waits until terminal (SDK default); otherwise block up to waitSecs.
        const waitSecs = taskMode ? undefined : parsed.waitSecs;
        const abortSignal = extra?.signal;

        try {
            if (abortSignal?.aborted) return {};

            const actorRun = await apifyClient
                .actor(APIFY_CODE_RUNTIME_ACTOR)
                .start({ code: parsed.code }, parsed.callOptions);
            log.debug('Started code-runtime run', { runId: actorRun.id, mcpSessionId, waitSecs });

            // Abort can arrive while start() was in flight — abort the newly created run.
            if (abortSignal?.aborted) {
                await abortRunOnSignal(actorRun.id, apifyClient);
                return {};
            }

            const linkContext = await getConsoleLinkContext(apifyToken, apifyClient);

            // waitSecs:0 means "fire and forget" — start() already returned the full run, skip re-fetch.
            if (waitSecs === 0) {
                return buildStartRunResponse({ actorName: APIFY_CODE_RUNTIME_ACTOR, actorRun, linkContext });
            }

            const fetchResult = await fetchActorRunData({
                runId: actorRun.id,
                waitSecs,
                actorName: APIFY_CODE_RUNTIME_ACTOR,
                client: apifyClient,
                progressTracker,
                abortSignal,
                mcpSessionId,
                onAbort: abortRunOnSignal,
            });

            if ('aborted' in fetchResult) return {};
            if ('error' in fetchResult) return fetchResult.error;

            return buildGetActorRunSuccessResponse({ ...fetchResult.result, widget: false, linkContext });
        } catch (error) {
            return buildCallActorErrorResponse({
                actorName: APIFY_CODE_RUNTIME_ACTOR,
                error,
                mcpSessionId,
                actorGetDetailsTool: HELPER_TOOLS.ACTOR_GET_DETAILS,
            });
        }
    },
} as const);
