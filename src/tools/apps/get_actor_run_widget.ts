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
} from '../core/get_actor_run_common.js';
import { getActorRunOutputSchema } from '../structured_output_schemas.js';

/**
 * Widget-only input: `runId` only. In the normal tool path, AJV validation
 * runs first and strips unknown keys at the boundary; `.strict()` mainly
 * protects any bypass paths by rejecting stray keys before use here.
 */
const getActorRunWidgetArgsSchema = z.object({
    runId: z.string()
        .min(1)
        .describe('The ID of the Actor run.'),
}).strict();

const GET_ACTOR_RUN_WIDGET_DESCRIPTION = dedent`
    Render an interactive UI element (widget) showing live progress and status of an Actor run.

    Use this tool ONLY when the user explicitly wants to see run progress visually
    (e.g., "show progress for run y2h7sK3Wc", "display the status of that run").

    For silent data lookups (run status, dataset IDs, stats, resource IDs), use
    ${HelperTools.ACTOR_RUNS_GET} instead — it returns the same data without rendering a widget.

    Input: the run ID only.
`;

export const getActorRunWidgetTool: ToolEntry = Object.freeze({
    type: 'internal',
    name: HelperTools.ACTOR_RUNS_GET_WIDGET,
    description: GET_ACTOR_RUN_WIDGET_DESCRIPTION,
    inputSchema: z.toJSONSchema(getActorRunWidgetArgsSchema) as ToolInputSchema,
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
        const { args, apifyClient: client, mcpSessionId } = toolArgs;
        const parsed = getActorRunWidgetArgsSchema.parse(args);

        try {
            const fetchResult = await fetchActorRunData({
                runId: parsed.runId,
                client,
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
