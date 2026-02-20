import { createApifyClientWithSkyfireSupport } from '../../apify-client.js';
import { TOOL_STATUS } from '../../const.js';
import { getWidgetConfig, WIDGET_URIS } from '../../resources/widgets.js';
import type { InternalToolArgs, ToolEntry } from '../../types.js';
import { logHttpError } from '../../utils/logging.js';
import { buildMCPResponse, buildUsageMeta } from '../../utils/mcp.js';
import {
    fetchActorRunData,
    getActorRunArgs,
    getActorRunMetadata,
} from '../core/get-actor-run-common.js';

/**
 * OpenAI mode get-actor-run tool.
 * Returns abbreviated text with widget metadata for interactive progress display.
 */
export const openaiGetActorRun: ToolEntry = Object.freeze({
    ...getActorRunMetadata,
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyToken, apifyMcpServer, mcpSessionId } = toolArgs;
        const parsed = getActorRunArgs.parse(args);

        const client = createApifyClientWithSkyfireSupport(apifyMcpServer, args, apifyToken);

        try {
            const fetchResult = await fetchActorRunData({
                runId: parsed.runId,
                client,
                mcpSessionId,
            });

            if ('error' in fetchResult) {
                return fetchResult.error;
            }

            const { run, structuredContent } = fetchResult.result;

            const statusText = run.status === 'SUCCEEDED' && structuredContent.dataset
                ? `Actor run ${parsed.runId} completed successfully with ${structuredContent.dataset.itemCount} items. A widget has been rendered with the details.`
                : `Actor run ${parsed.runId} status: ${run.status as string}. A progress widget has been rendered.`;

            const widgetConfig = getWidgetConfig(WIDGET_URIS.ACTOR_RUN);
            const usageMeta = buildUsageMeta(run);
            return buildMCPResponse({
                texts: [statusText],
                structuredContent,
                _meta: {
                    ...widgetConfig?.meta,
                    ...usageMeta,
                },
            });
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
} as const);
