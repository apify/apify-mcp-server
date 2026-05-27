import dedent from 'dedent';
import { z } from 'zod';

import { HelperTools, TOOL_STATUS } from '../../const.js';
import { getWidgetConfig, WIDGET_URIS } from '../../resources/widgets.js';
import type { HelperTool, ToolInputSchema } from '../../types.js';
import { ToolType } from '../../types.js';
import { compileSchema, fixZodSchemaRequired } from '../../utils/ajv.js';
import { buildMCPResponse, buildUsageMeta } from '../../utils/mcp.js';
import { getActorRunOutputSchema } from '../structured_output_schemas.js';
import { type FetchActorRunResult, WAIT_SECS_MAX, WIDGET_NO_POLL_NEXT_STEP } from './actor_run_response.js';

/** Default `waitSecs` for `get-actor-run`. Intentionally non-zero so polling callers wait briefly by default. */
export const WAIT_SECS_DEFAULT = 30;

/**
 * Zod schema for `get-actor-run` arguments — shared between default and widget variants.
 */
export const getActorRunArgs = z.object({
    runId: z.string().min(1).describe('The ID of the Actor run.'),
    waitSecs: z.number().int().min(0).max(WAIT_SECS_MAX).optional().default(WAIT_SECS_DEFAULT).describe(dedent`
            Maximum seconds to wait for the run to reach a terminal state (SUCCEEDED, FAILED, ABORTED, TIMED-OUT).
            0 returns immediately with the current status. Cap: ${WAIT_SECS_MAX}. Default: ${WAIT_SECS_DEFAULT}.
        `),
});

const GET_ACTOR_RUN_DESCRIPTION = `Get detailed information about a specific Actor run.

Returns run result: status, storages (datasets/keyValueStores alias map), stats, summary, nextStep.
- summary describes the past (e.g. "SUCCEEDED in 22s. 47 items; 3 fields available.").
- nextStep prescribes one primary follow-up action with identifiers interpolated (e.g. "Use get-dataset-items with datasetId=...").
- waitSecs (0–${WAIT_SECS_MAX}, default ${WAIT_SECS_DEFAULT}) waits up to that many seconds for terminal status before returning.

USAGE:
- Use to check the status of a run started with ${HelperTools.ACTOR_CALL}.
- Pass waitSecs > 0 to block until terminal (or until the cap elapses).
- If \`${HelperTools.ACTOR_CALL_WIDGET}\` or \`${HelperTools.ACTOR_RUNS_GET_WIDGET}\` rendered a widget for this run, do NOT poll here — the widget self-polls.

USAGE EXAMPLES:
- user_input: Show details of run y2h7sK3Wc
- user_input: Wait for run y2h7sK3Wc to finish`;

/**
 * Shared tool metadata for `get-actor-run` — everything except the `call` handler.
 * Mode-independent. Widget `_meta` lives in the widget variant.
 */
export const getActorRunMetadata: Omit<HelperTool, 'call'> = {
    type: ToolType.INTERNAL,
    name: HelperTools.ACTOR_RUNS_GET,
    description: GET_ACTOR_RUN_DESCRIPTION,
    // `fixZodSchemaRequired` strips fields with a real `default` from `required` so MCP clients
    // that read `tools/list` see `waitSecs` as optional (matching its runtime behavior).
    inputSchema: fixZodSchemaRequired(z.toJSONSchema(getActorRunArgs)) as ToolInputSchema,
    outputSchema: getActorRunOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(getActorRunArgs)),
    paymentRequired: true,
    annotations: {
        title: 'Get Actor run',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
};

// -----------------------------------------------------------------------------
// Response builders
// -----------------------------------------------------------------------------

export function buildGetActorRunError(runId: string, error: unknown): ReturnType<typeof buildMCPResponse> {
    const errMsg = error instanceof Error ? error.message : String(error);
    return buildMCPResponse({
        texts: [
            dedent`
            Failed to get Actor run '${runId}': ${errMsg}.
            Please verify the run ID and ensure that the run exists.
        `,
        ],
        isError: true,
        telemetry: { toolStatus: TOOL_STATUS.SOFT_FAIL },
    });
}

/**
 * Build the success response. `content[0]` is the JSON-stringified `structuredContent`
 * mirror (per MCP spec); `content[1]` carries an LLM-readable narrative — `summary` +
 * `nextStep` in default mode, a short pointer in widget mode.
 */
export function buildGetActorRunSuccessResponse(
    params: FetchActorRunResult & { widget: boolean },
): ReturnType<typeof buildMCPResponse> {
    const { run, structuredContent, widget } = params;

    if (!widget) {
        return buildMCPResponse({
            texts: [JSON.stringify(structuredContent), `${structuredContent.summary}\n${structuredContent.nextStep}`],
            structuredContent,
            _meta: buildUsageMeta(run),
        });
    }

    // Override nextStep so the model reading structuredContent (content[0]) also sees no-poll guidance.
    const widgetContent = { ...structuredContent, nextStep: WIDGET_NO_POLL_NEXT_STEP };
    return buildMCPResponse({
        texts: [
            JSON.stringify(widgetContent),
            `Actor run ${structuredContent.runId} status: ${structuredContent.status}. A run widget has been rendered.`,
        ],
        structuredContent: widgetContent,
        _meta: {
            ...(getWidgetConfig(WIDGET_URIS.ACTOR_RUN)?.meta ?? {}),
            ...(buildUsageMeta(run) ?? {}),
            'openai/widgetDescription': `Actor run progress for ${structuredContent.actorName ?? structuredContent.runId}`,
        },
    });
}
