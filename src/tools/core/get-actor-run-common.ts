import { z } from 'zod';

import log from '@apify/log';

import type { ApifyClient } from '../../apify-client.js';
import { HelperTools, TOOL_STATUS } from '../../const.js';
import { getWidgetConfig, WIDGET_URIS } from '../../resources/widgets.js';
import type { HelperTool, ToolInputSchema } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { buildMCPResponse } from '../../utils/mcp.js';
import { generateSchemaFromItems } from '../../utils/schema-generation.js';
import { getActorRunOutputSchema } from '../structured-output-schemas.js';

/**
 * Zod schema for get-actor-run arguments — shared between default and openai variants.
 */
export const getActorRunArgs = z.object({
    runId: z.string()
        .min(1)
        .describe('The ID of the Actor run.'),
});

const GET_ACTOR_RUN_DESCRIPTION = `Get detailed information about a specific Actor run by runId.
The results will include run metadata (status, timestamps), performance stats, and resource IDs (datasetId, keyValueStoreId, requestQueueId).

CRITICAL WARNING: NEVER call this tool immediately after call-actor in UI mode. The call-actor response includes a widget that automatically polls for updates. Calling this tool after call-actor is FORBIDDEN and unnecessary.

USAGE:
- Use ONLY when user explicitly asks about a specific run's status or details.
- Use ONLY for runs that were started outside the current conversation.
- DO NOT use this tool as part of the call-actor workflow in UI mode.

USAGE EXAMPLES:
- user_input: Show details of run y2h7sK3Wc (where y2h7sK3Wc is an existing run)
- user_input: What is the datasetId for run y2h7sK3Wc?`;

/**
 * Shared tool metadata for get-actor-run — everything except the `call` handler.
 * Used by both default and openai variants.
 */
export const getActorRunMetadata: Omit<HelperTool, 'call'> = {
    type: 'internal',
    name: HelperTools.ACTOR_RUNS_GET,
    description: GET_ACTOR_RUN_DESCRIPTION,
    inputSchema: z.toJSONSchema(getActorRunArgs) as ToolInputSchema,
    outputSchema: getActorRunOutputSchema,
    ajvValidate: compileSchema({ ...z.toJSONSchema(getActorRunArgs), additionalProperties: true }),
    requiresSkyfirePayId: true,
    _meta: {
        ...getWidgetConfig(WIDGET_URIS.ACTOR_RUN)?.meta,
    },
    annotations: {
        title: 'Get Actor run',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
    },
};

/**
 * Structured content returned from fetching actor run data.
 */
type ActorRunStructuredContent = {
    runId: string;
    actorName?: string;
    status: string;
    startedAt: string;
    finishedAt?: string;
    stats?: unknown;
    dataset?: {
        datasetId: string;
        itemCount: number;
        schema: unknown;
        previewItems: unknown[];
    };
};

/**
 * Result of fetching actor run data — shared between both variants.
 */
type FetchActorRunResult = {
    run: Record<string, unknown>;
    structuredContent: ActorRunStructuredContent;
};

/**
 * Fetches actor run data, resolves actor name, and fetches dataset results if completed.
 * Shared data-fetching logic used by both default and openai variants.
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
                toolStatus: TOOL_STATUS.SOFT_FAIL,
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
            itemCount: datasetItems.count,
            schema: generatedSchema || { type: 'object', properties: {} },
            previewItems: datasetItems.items,
        };
    }

    return { result: { run: run as unknown as Record<string, unknown>, structuredContent } };
}
