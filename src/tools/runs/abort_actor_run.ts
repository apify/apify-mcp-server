import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { respondOk } from '../../utils/mcp.js';
import { buildStats, buildStatusSummaryNextStep, type RunResponse, toIsoString } from '../actors/actor_run_response.js';
import { actorRunOutputSchema } from '../structured_output_schemas.js';

const abortRunArgs = z.object({
    runId: z.string().min(1).describe('The ID of the Actor run to abort.'),
    gracefully: z
        .boolean()
        .optional()
        .describe('If true, the Actor run will abort gracefully with a 30-second timeout.'),
});

/**
 * https://docs.apify.com/api/v2/actor-run-abort-post
 */
export const abortActorRun: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_RUNS_ABORT,
    title: 'Abort Actor run',
    description: `Abort an Actor run that is currently starting or running.
For runs with status FINISHED, FAILED, ABORTING, or TIMED-OUT, this call has no effect.
The results will include the updated run details after the abort request.

USAGE:
- Use when you need to stop a run that is taking too long or misconfigured.

USAGE EXAMPLES:
- user_input: Abort run y2h7sK3Wc
- user_input: Gracefully abort run y2h7sK3Wc`,
    inputSchema: z.toJSONSchema(abortRunArgs) as ToolInputSchema,
    outputSchema: actorRunOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(abortRunArgs)),
    paymentRequired: true,
    annotations: {
        title: 'Abort Actor run',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client } = toolArgs;
        const parsed = abortRunArgs.parse(args);
        const run = await client.run(parsed.runId).abort({ gracefully: parsed.gracefully });

        const dataset = run.defaultDatasetId ? { id: run.defaultDatasetId } : undefined;
        const keyValueStore = run.defaultKeyValueStoreId ? { id: run.defaultKeyValueStoreId } : undefined;
        const { summary, nextStep } = buildStatusSummaryNextStep({ run, dataset, keyValueStore });

        const structuredContent: RunResponse = {
            runId: run.id,
            actorId: run.actId,
            status: run.status,
            statusMessage: run.statusMessage ?? undefined,
            startedAt: toIsoString(run.startedAt),
            finishedAt: toIsoString(run.finishedAt),
            stats: buildStats(run),
            storages: {
                ...(dataset && { datasets: { default: dataset } }),
                ...(keyValueStore && { keyValueStores: { default: keyValueStore } }),
            },
            summary,
            nextStep,
        };

        return respondOk([JSON.stringify(structuredContent), `${summary}\n${nextStep}`], { structuredContent });
    },
} as const);
