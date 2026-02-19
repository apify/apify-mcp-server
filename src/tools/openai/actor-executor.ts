import log from '@apify/log';

import { HelperTools } from '../../const.js';
import { getWidgetConfig, WIDGET_URIS } from '../../resources/widgets.js';
import type { ActorExecutionParams, ActorExecutionResult, ActorExecutor } from '../../types.js';

/**
 * OpenAI actor executor for UI mode.
 * Runs actors asynchronously — starts the run and returns immediately with widget metadata.
 * The widget automatically tracks progress and updates the UI.
 */
export const openaiActorExecutor: ActorExecutor = {
    async executeActorTool(params: ActorExecutionParams): Promise<ActorExecutionResult> {
        if (params.abortSignal?.aborted) {
            return null;
        }

        const actorClient = params.apifyClient.actor(params.actorFullName);
        const actorRun = await actorClient.start(params.input, params.callOptions);

        log.debug('Started Actor run (async, direct actor tool)', {
            actorName: params.actorFullName,
            runId: actorRun.id,
            mcpSessionId: params.mcpSessionId,
        });

        const structuredContent: Record<string, unknown> = {
            runId: actorRun.id,
            actorName: params.actorFullName,
            status: actorRun.status,
            startedAt: actorRun.startedAt?.toISOString() || '',
            input: params.input,
        };

        const responseText = `Started Actor "${params.actorFullName}" (Run ID: ${actorRun.id}).

A live progress widget has been rendered that automatically tracks this run and refreshes status every few seconds until completion.

The widget will update the context with run status and datasetId when the run completes. Once complete (or if the user requests results), use ${HelperTools.ACTOR_OUTPUT_GET} with the datasetId to retrieve the output.

Do NOT proactively poll using ${HelperTools.ACTOR_RUNS_GET}. Wait for the widget state update or user instructions. Ask the user what they would like to do next.`;

        const widgetConfig = getWidgetConfig(WIDGET_URIS.ACTOR_RUN);
        return {
            content: [{ type: 'text' as const, text: responseText }],
            structuredContent,
            _meta: {
                ...widgetConfig?.meta,
                'openai/widgetDescription': `Actor run progress for ${params.actorFullName}`,
            },
        };
    },
};
