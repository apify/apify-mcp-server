import dedent from 'dedent';
import { z } from 'zod';

import log from '@apify/log';

import type { ApifyClient } from '../../apify_client.js';
import { FAILURE_CATEGORY, HelperTools, TOOL_STATUS } from '../../const.js';
import { getWidgetConfig, WIDGET_URIS } from '../../resources/widgets.js';
import type { HelperTool, ToolInputSchema } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { buildMCPResponse, buildUsageMeta } from '../../utils/mcp.js';
import { generateSchemaFromItems } from '../../utils/schema_generation.js';
import { getActorRunOutputSchema } from '../structured_output_schemas.js';

/**
 * Zod schema for get-actor-run arguments — shared between default and widget variants.
 */
export const getActorRunArgs = z.object({
    runId: z.string()
        .min(1)
        .describe('The ID of the Actor run.'),
});

const GET_ACTOR_RUN_DESCRIPTION = `Get detailed information about a specific Actor run by runId.
The results will include run metadata (status, timestamps), performance stats, and resource IDs (datasetId, keyValueStoreId, requestQueueId).

USAGE:
- Use when the user asks about a specific run's status or details.
- Use to check the status of a run started with call-actor (e.g., before fetching output).
- Returns pure data with no UI.
- If \`${HelperTools.ACTOR_CALL_WIDGET}\` or \`${HelperTools.ACTOR_RUNS_GET_WIDGET}\` are available in this session, do NOT call this after them — those render self-polling widgets, additional polling here is forbidden duplicate work.

USAGE EXAMPLES:
- user_input: Show details of run y2h7sK3Wc (where y2h7sK3Wc is an existing run)
- user_input: What is the datasetId for run y2h7sK3Wc?`;

/**
 * Shared tool metadata for get-actor-run — everything except the `call` handler.
 * Mode-independent, data-only. No widget _meta here; the widget variant in
 * `src/tools/apps/get_actor_run_widget.ts` owns UI rendering.
 */
export const getActorRunMetadata: Omit<HelperTool, 'call'> = {
    type: 'internal',
    name: HelperTools.ACTOR_RUNS_GET,
    description: GET_ACTOR_RUN_DESCRIPTION,
    inputSchema: z.toJSONSchema(getActorRunArgs) as ToolInputSchema,
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

/**
 * Structured content returned from fetching actor run data.
 */
export type ActorRunStructuredContent = {
    runId: string;
    actorName?: string;
    status: string;
    startedAt: string;
    finishedAt?: string;
    stats?: unknown;
    dataset?: {
        datasetId: string;
        totalItemCount: number;
        previewItemCount: number;
        schema: unknown;
        previewItems: unknown[];
    };
};

/**
 * Result of fetching actor run data — shared between both variants.
 */
export type FetchActorRunResult = {
    run: Record<string, unknown>;
    structuredContent: ActorRunStructuredContent;
};

/**
 * Builds the standard tool error response for get-actor-run.
 */
export function buildGetActorRunError(runId: string, error: unknown): ReturnType<typeof buildMCPResponse> {
    return buildMCPResponse({
        texts: [dedent`
            Failed to get Actor run '${runId}': ${error instanceof Error ? error.message : String(error)}.
            Please verify the run ID and ensure that the run exists.
        `],
        isError: true,
        telemetry: { toolStatus: TOOL_STATUS.SOFT_FAIL },
    });
}

/**
 * Builds the tool success response for get-actor-run in default or widget mode.
 */
export function buildGetActorRunSuccessResponse(
    params: FetchActorRunResult & { widget: boolean },
): ReturnType<typeof buildMCPResponse> {
    const { run, structuredContent, widget } = params;

    if (!widget) {
        return buildMCPResponse({
            texts: [`# Actor Run Information\n\`\`\`json\n${JSON.stringify(run)}\n\`\`\``],
            structuredContent,
            _meta: buildUsageMeta(run),
        });
    }

    const statusText = structuredContent.status === 'SUCCEEDED' && structuredContent.dataset
        ? `Actor run ${structuredContent.runId} completed successfully with ${structuredContent.dataset.totalItemCount} items. A widget has been rendered with the details.`
        : `Actor run ${structuredContent.runId} status: ${structuredContent.status}. A progress widget has been rendered.`;

    return buildMCPResponse({
        texts: [statusText],
        structuredContent,
        _meta: {
            ...(getWidgetConfig(WIDGET_URIS.ACTOR_RUN)?.meta ?? {}),
            ...(buildUsageMeta(run) ?? {}),
            'openai/widgetDescription': `Actor run progress for ${structuredContent.actorName ?? structuredContent.runId}`,
        },
    });
}

/**
 * Fetches actor run data, resolves actor name, and fetches dataset results if completed.
 * Shared data-fetching logic used by both default and apps variants.
 *
 * Returns the run data and structured content, or an early error response.
 */
export async function fetchActorRunData(params: {
    runId: string;
    client: ApifyClient;
    mcpSessionId?: string;
}): Promise<{ error: object } | { result: FetchActorRunResult }> {
    const { runId, client, mcpSessionId } = params;

    const run = await client.run(runId).get();

    if (!run) {
        return {
            error: buildMCPResponse({
                texts: [`Run with ID '${runId}' not found.`],
                isError: true,
                telemetry: { toolStatus: TOOL_STATUS.SOFT_FAIL, failureCategory: FAILURE_CATEGORY.INVALID_INPUT },
            }),
        };
    }

    log.debug('Get actor run', { runId, status: run.status, mcpSessionId });

    let actorName: string | undefined;
    if (run.actId) {
        try {
            const actor = await client.actor(run.actId).get();
            if (actor) {
                actorName = `${actor.username}/${actor.name}`;
            }
        } catch (error) {
            log.warning(`Failed to fetch actor name for run ${runId}`, { mcpSessionId, error });
        }
    }

    const structuredContent: ActorRunStructuredContent = {
        runId: run.id,
        actorName,
        status: run.status,
        startedAt: run.startedAt?.toISOString() || '',
        finishedAt: run.finishedAt?.toISOString(),
        stats: run.stats,
    };

    // If completed, fetch dataset results
    if (run.status === 'SUCCEEDED' && run.defaultDatasetId) {
        const dataset = client.dataset(run.defaultDatasetId);
        const datasetItems = await dataset.listItems({ limit: 5 });

        const generatedSchema = generateSchemaFromItems(datasetItems.items, {
            clean: true,
            arrayMode: 'all',
        });

        structuredContent.dataset = {
            datasetId: run.defaultDatasetId,
            totalItemCount: datasetItems.total,
            previewItemCount: datasetItems.items.length,
            schema: generatedSchema || { type: 'object', properties: {} },
            previewItems: datasetItems.items,
        };
    }

    return { result: { run: run as unknown as Record<string, unknown>, structuredContent } };
}
