import { z } from 'zod';

import log from '@apify/log';

import { createApifyClientWithSkyfireSupport } from '../apify-client.js';
import { HelperTools, TOOL_STATUS } from '../const.js';
import { getWidgetConfig, WIDGET_URIS } from '../resources/widgets.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../types.js';
import { compileSchema } from '../utils/ajv.js';
import { logHttpError } from '../utils/logging.js';
import { buildMCPResponse } from '../utils/mcp.js';
import { generateSchemaFromItems } from '../utils/schema-generation.js';
import { getActorRunOutputSchema } from './structured-output-schemas.js';

const getActorRunArgs = z.object({
    runId: z.string()
        .min(1)
        .describe('The ID of the Actor run.'),
});

const abortRunArgs = z.object({
    runId: z.string()
        .min(1)
        .describe('The ID of the Actor run to abort.'),
    gracefully: z.boolean().optional().describe('If true, the Actor run will abort gracefully with a 30-second timeout.'),
});

/**
 * https://docs.apify.com/api/v2/actor-run-get
 */
export const getActorRun: ToolEntry = {
    type: 'internal',
    name: HelperTools.ACTOR_RUNS_GET,
    description: `Get detailed information about a specific Actor run by runId.
The results will include run metadata (status, timestamps), performance stats, and resource IDs (datasetId, keyValueStoreId, requestQueueId).

CRITICAL WARNING: NEVER call this tool immediately after call-actor in UI mode. The call-actor response includes a widget that automatically polls for updates. Calling this tool after call-actor is FORBIDDEN and unnecessary.

USAGE:
- Use ONLY when user explicitly asks about a specific run's status or details.
- Use ONLY for runs that were started outside the current conversation.
- DO NOT use this tool as part of the call-actor workflow in UI mode.

USAGE EXAMPLES:
- user_input: Show details of run y2h7sK3Wc (where y2h7sK3Wc is an existing run)
- user_input: What is the datasetId for run y2h7sK3Wc?`,
    inputSchema: z.toJSONSchema(getActorRunArgs) as ToolInputSchema,
    outputSchema: getActorRunOutputSchema,
    /**
     * Allow additional properties for Skyfire mode to pass `skyfire-pay-id`.
     */
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
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyToken, apifyMcpServer, mcpSessionId } = toolArgs;
        const parsed = getActorRunArgs.parse(args);

        const client = createApifyClientWithSkyfireSupport(apifyMcpServer, args, apifyToken);

        try {
            const run = await client.run(parsed.runId).get();

            if (!run) {
                return buildMCPResponse({
                    texts: [`Run with ID '${parsed.runId}' not found.`],
                    isError: true,
                    toolStatus: TOOL_STATUS.SOFT_FAIL,
                });
            }

            log.debug('Get actor run', { runId: parsed.runId, status: run.status, mcpSessionId });

            let actorName: string | undefined;
            if (run.actId) {
                try {
                    const actor = await client.actor(run.actId).get();
                    if (actor) {
                        actorName = `${actor.username}/${actor.name}`;
                    }
                } catch (error) {
                    log.warning(`Failed to fetch actor name for run ${parsed.runId}`, { mcpSessionId, error });
                }
            }

            const structuredContent: {
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
            } = {
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

            // When UI mode is disabled, return full text response without widget metadata
            if (apifyMcpServer.options.uiMode === 'openai') {
                const statusText = run.status === 'SUCCEEDED' && structuredContent.dataset
                    ? `Actor run ${parsed.runId} completed successfully with ${structuredContent.dataset.itemCount} items. A widget has been rendered with the details.`
                    : `Actor run ${parsed.runId} status: ${run.status}. A progress widget has been rendered.`;

                const widgetConfig = getWidgetConfig(WIDGET_URIS.ACTOR_RUN);
                return buildMCPResponse({
                    texts: [statusText],
                    structuredContent,
                    _meta: {
                        ...widgetConfig?.meta,
                    },
                });
            }

            const texts = [
                `# Actor Run Information\n\`\`\`json\n${JSON.stringify(run, null, 2)}\n\`\`\``,
            ];

            return buildMCPResponse({ texts, structuredContent });
        } catch (error) {
            logHttpError(error, 'Failed to get Actor run', { runId: parsed.runId });
            return buildMCPResponse({
                texts: [`Failed to get Actor run '${parsed.runId}': ${error instanceof Error ? error.message : String(error)}.
Please verify the run ID and ensure that the run exists.`],
                isError: true,
                toolStatus: TOOL_STATUS.SOFT_FAIL,
            });
        }
    },
} as const;

const GetRunLogArgs = z.object({
    runId: z.string().describe('The ID of the Actor run.'),
    lines: z.number()
        .max(50)
        .describe('Output the last NUM lines, instead of the last 10')
        .default(10),
});

/**
 * https://docs.apify.com/api/v2/actor-run-get
 *  /v2/actor-runs/{runId}/log{?token}
 */
export const getActorRunLog: ToolEntry = {
    type: 'internal',
    name: HelperTools.ACTOR_RUNS_LOG,
    description: `Retrieve recent log lines for a specific Actor run.
The results will include the last N lines of the run's log output (plain text).

USAGE:
- Use when you need to inspect recent logs to debug or monitor a run.

USAGE EXAMPLES:
- user_input: Show last 20 lines of logs for run y2h7sK3Wc
- user_input: Get logs for run y2h7sK3Wc`,
    inputSchema: z.toJSONSchema(GetRunLogArgs) as ToolInputSchema,
    // It does not make sense to add structured output here since the log API just returns plain text
    /**
     * Allow additional properties for Skyfire mode to pass `skyfire-pay-id`.
     */
    ajvValidate: compileSchema({ ...z.toJSONSchema(GetRunLogArgs), additionalProperties: true }),
    requiresSkyfirePayId: true,
    annotations: {
        title: 'Get Actor run log',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyToken, apifyMcpServer } = toolArgs;
        const parsed = GetRunLogArgs.parse(args);

        const client = createApifyClientWithSkyfireSupport(apifyMcpServer, args, apifyToken);
        const v = await client.run(parsed.runId).log().get() ?? '';
        const lines = v.split('\n');
        const text = lines.slice(lines.length - parsed.lines - 1, lines.length).join('\n');
        return { content: [{ type: 'text', text }] };
    },
} as const;

/**
 * https://docs.apify.com/api/v2/actor-run-abort-post
 */
export const abortActorRun: ToolEntry = {
    type: 'internal',
    name: HelperTools.ACTOR_RUNS_ABORT,
    description: `Abort an Actor run that is currently starting or running.
For runs with status FINISHED, FAILED, ABORTING, or TIMED-OUT, this call has no effect.
The results will include the updated run details after the abort request.

USAGE:
- Use when you need to stop a run that is taking too long or misconfigured.

USAGE EXAMPLES:
- user_input: Abort run y2h7sK3Wc
- user_input: Gracefully abort run y2h7sK3Wc`,
    inputSchema: z.toJSONSchema(abortRunArgs) as ToolInputSchema,
    /**
     * Allow additional properties for Skyfire mode to pass `skyfire-pay-id`.
     */
    ajvValidate: compileSchema({ ...z.toJSONSchema(abortRunArgs), additionalProperties: true }),
    requiresSkyfirePayId: true,
    annotations: {
        title: 'Abort Actor run',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyToken, apifyMcpServer } = toolArgs;
        const parsed = abortRunArgs.parse(args);

        const client = createApifyClientWithSkyfireSupport(apifyMcpServer, args, apifyToken);
        const v = await client.run(parsed.runId).abort({ gracefully: parsed.gracefully });
        return { content: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(v)}\n\`\`\`` }] };
    },
} as const;
