import React, { useCallback } from 'react';

import { type ActorRunOutput, LiveActorRunWidget } from '@apify/mcp-widgets';

import { useMcpApp } from '../../context/mcp-app-context';
import { useWidgetProps } from '../../hooks/use-widget-props';
import { extractActorRunErrorMessage, ACTOR_RUN_META_KEY } from '../../utils/actor-run';

type ActorRunMeta = { [key in typeof ACTOR_RUN_META_KEY]?: { usageTotalUsd?: number } } | null | undefined;

function extractUsageTotalUsd(meta: ActorRunMeta): number | undefined {
    const value = meta?.[ACTOR_RUN_META_KEY]?.usageTotalUsd;
    return typeof value === 'number' ? value : undefined;
}

/**
 * Resolves runId from URL query parameter (?runId=xxx).
 * Used when the host overwrites toolResult with a different tool call (e.g. search-actors),
 * so the widget can still show the correct run when opened for a call-actor response.
 */
function getRunIdFromUrl(): string | null {
    if (typeof window === 'undefined') return null;
    const params = new URLSearchParams(window.location.search);
    const runId = params.get('runId');
    return runId?.trim() || null;
}

export const ActorRun: React.FC = () => {
    const { app, toolResult } = useMcpApp();
    const toolOutput = useWidgetProps<ActorRunOutput>();
    const stableRunId = getRunIdFromUrl();

    // When the host overwrites toolResult with another tool (e.g. search-actors), toolOutput has no runId;
    // the runId from the URL still names the run, and the widget fetches the rest.
    const output = toolOutput?.runId ? toolOutput : stableRunId ? { runId: stableRunId } : null;

    // The model learns how the run ended on its next turn.
    const handleRunFinished = useCallback(
        (finished: ActorRunOutput) => {
            const dataset = finished.storages?.datasets?.default;
            const text = [
                `Actor run ${finished.runId} finished with status: ${(finished.status ?? '').toUpperCase()}.`,
                dataset?.id ? `Dataset ID: ${dataset.id}` : null,
                dataset?.itemCount != null ? `Items scraped: ${dataset.itemCount}` : null,
            ]
                .filter(Boolean)
                .join(' ');
            void app?.updateModelContext({ content: [{ type: 'text', text }] }).catch(() => {});
        },
        [app],
    );

    return (
        <LiveActorRunWidget
            output={output}
            errorMessage={extractActorRunErrorMessage(toolResult)}
            costUsd={toolOutput?.runId ? extractUsageTotalUsd(toolResult?._meta as ActorRunMeta) : undefined}
            onRunFinished={handleRunFinished}
        />
    );
};
