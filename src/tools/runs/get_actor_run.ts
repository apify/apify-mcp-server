import dedent from 'dedent';
import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import { buildActorRunWidgetMeta } from '../../resources/widgets.js';
import type { ConsoleLinkContext, HelperTool, InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema, fixZodSchemaRequired } from '../../utils/ajv.js';
import { getConsoleLinkContext } from '../../utils/console_link.js';
import { logHttpError } from '../../utils/logging.js';
import { buildUsageMeta, respondAborted, respondOk, respondUserError, type ToolResponse } from '../../utils/mcp.js';
import {
    applyConsoleLinks,
    type FetchActorRunResult,
    fetchActorRunData,
    WAIT_SECS_MAX,
    WIDGET_NO_POLL_NEXT_STEP,
} from '../actors/actor_run_response.js';
import { actorRunOutputSchema } from '../structured_output_schemas.js';

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
- Use to check the status of a run started with ${HELPER_TOOLS.ACTOR_CALL}.
- Pass waitSecs > 0 to block until terminal (or until the cap elapses).
- If \`${HELPER_TOOLS.ACTOR_CALL_WIDGET}\` or \`${HELPER_TOOLS.ACTOR_RUNS_GET_WIDGET}\` rendered a widget for this run, do NOT poll here — the widget self-polls.

USAGE EXAMPLES:
- user_input: Show details of run y2h7sK3Wc
- user_input: Wait for run y2h7sK3Wc to finish`;

/**
 * Shared tool metadata for `get-actor-run` — everything except the `call` handler.
 * Mode-independent. Widget `_meta` lives in the widget variant.
 */
export const getActorRunMetadata: Omit<HelperTool, 'call'> = {
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_RUNS_GET,
    title: 'Get Actor run',
    description: GET_ACTOR_RUN_DESCRIPTION,
    // `fixZodSchemaRequired` strips fields with a real `default` from `required` so MCP clients
    // that read `tools/list` see `waitSecs` as optional (matching its runtime behavior).
    inputSchema: fixZodSchemaRequired(z.toJSONSchema(getActorRunArgs)) as ToolInputSchema,
    outputSchema: actorRunOutputSchema,
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

export function buildGetActorRunError(runId: string, error: unknown): ToolResponse {
    const errMsg = error instanceof Error ? error.message : String(error);
    return respondUserError(dedent`
        Failed to get Actor run '${runId}': ${errMsg}.
        Please verify the run ID and ensure that the run exists.
    `);
}

/**
 * Build the success response. `content[0]` is the JSON-stringified `structuredContent`
 * mirror (per MCP spec); `content[1]` carries an LLM-readable narrative of `summary` + `nextStep`.
 */
export function buildGetActorRunResponse(
    params: FetchActorRunResult & { linkContext?: ConsoleLinkContext },
): ToolResponse {
    const { run, structuredContent, linkContext } = params;

    // Mints the `apifyConsoleUrl` fields onto structuredContent and returns the narrative suffix in one pass.
    const consoleLinks = applyConsoleLinks(structuredContent, linkContext);
    return respondOk(
        [
            JSON.stringify(structuredContent),
            `${structuredContent.summary}\n${structuredContent.nextStep}${consoleLinks}`,
        ],
        { structuredContent, meta: buildUsageMeta(run) },
    );
}

/**
 * Build the widget success response. `content[1]` carries a short pointer instead of the
 * summary/nextStep narrative. Used only by `*-widget` tools; does not apply console links.
 */
export function buildGetActorRunWidgetResponse(params: FetchActorRunResult): ToolResponse {
    const { run, structuredContent } = params;

    // Override nextStep so the model reading structuredContent (content[0]) also sees no-poll guidance.
    const widgetContent = { ...structuredContent, nextStep: WIDGET_NO_POLL_NEXT_STEP };
    return respondOk(
        [
            JSON.stringify(widgetContent),
            `Actor run ${structuredContent.runId} status: ${structuredContent.status}. A run widget has been rendered.`,
        ],
        {
            structuredContent: widgetContent,
            meta: {
                ...buildActorRunWidgetMeta(structuredContent.actorName ?? structuredContent.runId),
                ...(buildUsageMeta(run) ?? {}),
            },
        },
    );
}

/**
 * Default mode `get-actor-run` — returns without any widget metadata.
 */
export const getActorRun: ToolEntry = Object.freeze({
    ...getActorRunMetadata,
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client, apifyToken, progressTracker, mcpSessionId, extra } = toolArgs;
        const parsed = getActorRunArgs.parse(args);

        try {
            const fetchResult = await fetchActorRunData({
                runId: parsed.runId,
                waitSecs: parsed.waitSecs,
                client,
                progressTracker,
                abortSignal: extra?.signal,
                mcpSessionId,
            });

            // Per MCP spec, receivers SHOULD NOT send a response for a cancelled request:
            // https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation
            if ('aborted' in fetchResult) return respondAborted();
            if ('error' in fetchResult) return fetchResult.error;

            return buildGetActorRunResponse({
                ...fetchResult.result,
                linkContext: await getConsoleLinkContext(apifyToken, client),
            });
        } catch (error) {
            logHttpError(error, 'Failed to get Actor run', { runId: parsed.runId });
            return buildGetActorRunError(parsed.runId, error);
        }
    },
} as const);
