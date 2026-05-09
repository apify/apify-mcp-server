import dedent from 'dedent';
import { z } from 'zod';

import { HelperTools } from '../../const.js';
import { getWidgetConfig, WIDGET_URIS } from '../../resources/widgets.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { logHttpError } from '../../utils/logging.js';
import {
    buildGetActorRunError,
    buildGetActorRunSuccessResponse,
    fetchActorRunData,
    WAIT_SECS_MAX,
} from '../core/get_actor_run_common.js';
import { getActorRunOutputSchema } from '../structured_output_schemas.js';

/**
 * Widget args. Default `waitSecs = 0` so the initial widget render is immediate; the widget UI
 * polls with `waitSecs: 0` for the same reason. Strict so stray keys are rejected on bypass paths.
 */
const getActorRunWidgetArgsSchema = z.object({
    runId: z.string()
        .min(1)
        .describe('The ID of the Actor run.'),
    waitSecs: z.number()
        .int()
        .min(0)
        .max(WAIT_SECS_MAX)
        .optional()
        .default(0)
        .describe(`Maximum seconds to wait for the run to reach a terminal state. Default 0 — the widget UI polls; the tool itself does not block.`),
}).strict();

const GET_ACTOR_RUN_WIDGET_DESCRIPTION = dedent`
    Render an interactive UI element (widget) showing live progress and status of an Actor run.

    Use this tool ONLY when the user explicitly wants to see run progress visually
    (e.g., "show progress for run y2h7sK3Wc", "display the status of that run").

    For silent data lookups (run status, dataset IDs, stats, resource IDs), use
    ${HelperTools.ACTOR_RUNS_GET} instead — it returns the same data without rendering a widget.

    Inputs: runId (required), waitSecs (optional; default 0 — the widget self-polls).
`;

export const getActorRunWidgetTool: ToolEntry = Object.freeze({
    type: 'internal',
    name: HelperTools.ACTOR_RUNS_GET_WIDGET,
    description: GET_ACTOR_RUN_WIDGET_DESCRIPTION,
    inputSchema: { ...(z.toJSONSchema(getActorRunWidgetArgsSchema) as ToolInputSchema) },
    outputSchema: getActorRunOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(getActorRunWidgetArgsSchema)),
    paymentRequired: true,
    _meta: {
        ...getWidgetConfig(WIDGET_URIS.ACTOR_RUN)?.meta,
    },
    annotations: {
        title: 'Get Actor run (widget)',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client, progressTracker, mcpSessionId } = toolArgs;
        const parsed = getActorRunWidgetArgsSchema.parse(args);

        try {
            const fetchResult = await fetchActorRunData({
                runId: parsed.runId,
                waitSecs: parsed.waitSecs,
                client,
                progressTracker,
                mcpSessionId,
            });

            if ('error' in fetchResult) {
                return fetchResult.error;
            }

            return buildGetActorRunSuccessResponse({ ...fetchResult.result, widget: true });
        } catch (error) {
            logHttpError(error, 'Failed to get Actor run (widget)', { runId: parsed.runId });
            return buildGetActorRunError(parsed.runId, error);
        }
    },
} as const);
