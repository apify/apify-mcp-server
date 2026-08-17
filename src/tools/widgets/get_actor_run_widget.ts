import dedent from 'dedent';
import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import { getWidgetConfig, WIDGET_URIS } from '../../resources/widgets.js';
import type { InternalToolArgs, ToolDescriptionContext, ToolEntry, ToolInputSchema } from '../../types.js';
import { ALL_TOOLS_PRESENT, TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { logHttpError } from '../../utils/logging.js';
import { respondAborted } from '../../utils/mcp.js';
import { fetchActorRunData } from '../actors/actor_run_response.js';
import { buildGetActorRunError, buildGetActorRunWidgetResponse } from '../runs/get_actor_run.js';
import { actorRunOutputSchema } from '../structured_output_schemas.js';

/**
 * Widget input is `runId` only. The tool always returns immediately so the widget can render
 * without delay; live status updates are driven by the widget UI itself, which polls
 * `get-actor-run` with `waitSecs: 0`. Strict so stray keys are rejected on bypass paths.
 */
const getActorRunWidgetArgsSchema = z
    .object({
        runId: z.string().min(1).describe('The ID of the Actor run.'),
    })
    .strict();

function buildDescription({ hasTool }: ToolDescriptionContext): string {
    return dedent`
        Render an interactive UI element (widget) that displays live progress and status of an Actor run.

        The tool returns immediately after rendering the widget — it never blocks waiting for the run.
        The widget itself polls run status and updates in place until the run reaches a terminal state.

        Use this tool ONLY when the user explicitly wants to see run progress visually
        (e.g., "show progress for run y2h7sK3Wc", "display the status of that run").
        ${hasTool(HELPER_TOOLS.ACTOR_RUNS_GET) ? `\nFor silent data lookups (run status, dataset IDs, stats, resource IDs), use ${HELPER_TOOLS.ACTOR_RUNS_GET} instead — it returns the same data without rendering a widget.` : ''}
    `;
}

export const getActorRunWidget: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_RUNS_GET_WIDGET,
    title: 'Get Actor run (widget)',
    description: buildDescription(ALL_TOOLS_PRESENT),
    buildDescription,
    inputSchema: z.toJSONSchema(getActorRunWidgetArgsSchema) as ToolInputSchema,
    outputSchema: actorRunOutputSchema,
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
                waitSecs: 0,
                client,
                mcpSessionId,
            });

            // Widget always passes waitSecs=0 with no abort signal, so 'aborted' is unreachable
            // here — the discriminator just keeps the type-checker happy.
            if ('aborted' in fetchResult) return respondAborted();
            if ('error' in fetchResult) return fetchResult.error;

            return buildGetActorRunWidgetResponse({ ...fetchResult.result });
        } catch (error) {
            logHttpError(error, 'Failed to get Actor run (widget)', { runId: parsed.runId });
            return buildGetActorRunError(parsed.runId, error);
        }
    },
} as const);
