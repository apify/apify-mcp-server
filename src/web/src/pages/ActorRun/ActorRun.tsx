import React, { useEffect, useState } from 'react';

import { type ActorRunOutput, ActorRunWidget } from '@apify/mcp-widgets';

import { useMcpApp } from '../../context/mcp-app-context';
import { useWidgetProps } from '../../hooks/use-widget-props';
import { extractActorRunErrorMessage, ACTOR_RUN_META_KEY } from '../../utils/actor-run';

/** A `get-actor-run` / `call-actor` result: the run itself plus the cost the server sends in `_meta`. */
type RunSnapshot = {
    output: ActorRunOutput;
    costUsd?: number;
};

const TERMINAL_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);
const delay = async (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type ActorRunMeta = { [key in typeof ACTOR_RUN_META_KEY]?: { usageTotalUsd?: number } } | null | undefined;

function extractUsageTotalUsd(meta: ActorRunMeta): number | undefined {
    const value = meta?.[ACTOR_RUN_META_KEY]?.usageTotalUsd;
    return typeof value === 'number' ? value : undefined;
}

const getDataset = (output: ActorRunOutput) => output.storages?.datasets?.default;

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
    const toolResponseMetadata = (toolResult?._meta ?? null) as ActorRunMeta;
    const stableRunId = getRunIdFromUrl();
    const toolErrorMessage = extractActorRunErrorMessage(toolResult);

    const [run, setRun] = useState<RunSnapshot | null>(null);
    const [pictureUrl, setPictureUrl] = useState<string | undefined>(undefined);
    /**
     * Run response carries identifiers only; item bodies are fetched separately.
     * We fetch a small preview via `get-dataset-items` once the run reaches SUCCEEDED and a datasetId is available.
     */
    const [previewItems, setPreviewItems] = useState<Record<string, unknown>[] | null>(null);

    const runId = run?.output.runId;
    const status = (run?.output.status || 'RUNNING').toUpperCase();
    const actorName = run?.output.actorName;
    const dataset = run ? getDataset(run.output) : undefined;

    // Initialize the run from toolOutput (call-actor result) or by fetching run when we have a stable runId.
    // When the host overwrites toolResult with another tool (e.g. search-actors), toolOutput has no runId;
    // use runId from URL so this widget still shows the correct run.
    useEffect(() => {
        if (run) return;

        if (toolOutput?.runId) {
            setRun({ output: toolOutput, costUsd: extractUsageTotalUsd(toolResponseMetadata) });
            return;
        }

        if (!stableRunId || !app) return;

        let cancelled = false;
        const fetchRunByRunId = async () => {
            try {
                const response = await app.callServerTool({
                    name: 'get-actor-run',
                    arguments: { runId: stableRunId, waitSecs: 0 },
                });
                if (cancelled) return;
                const data = response?.structuredContent as ActorRunOutput | undefined;
                if (data?.runId) {
                    setRun({ output: data, costUsd: extractUsageTotalUsd(response?._meta as ActorRunMeta) });
                }
            } catch (err) {
                if (!cancelled) console.error('[ActorRun] Failed to fetch run by runId:', err);
            }
        };
        void fetchRunByRunId();
        return () => {
            cancelled = true;
        };
    }, [toolOutput, run, toolResponseMetadata, stableRunId, app]);

    // Drop a stale preview when the dataset id changes (e.g. host swaps toolResult to a new run).
    useEffect(() => {
        setPreviewItems(null);
    }, [dataset?.id]);

    // Once the run reaches SUCCEEDED, fetch a small preview via get-dataset-items.
    // Run response carries shape + identifiers only; item bodies are fetched via get-dataset-items.
    useEffect(() => {
        if (!app || !runId) return;
        if (previewItems !== null) return;
        if (status !== 'SUCCEEDED') return;
        if (!dataset?.id || !dataset.itemCount) return;

        let cancelled = false;
        (async () => {
            try {
                const response = await app.callServerTool({
                    name: 'get-dataset-items',
                    arguments: { datasetId: dataset.id, limit: 20, clean: true },
                });
                if (cancelled) return;
                const content = response?.structuredContent as { items?: Record<string, unknown>[] } | undefined;
                setPreviewItems(Array.isArray(content?.items) ? content.items : []);
            } catch (err) {
                if (!cancelled) {
                    console.error('[ActorRun] Failed to fetch dataset items:', err);
                    setPreviewItems([]);
                }
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [app, runId, status, dataset?.id, dataset?.itemCount, previewItems]);

    // Fetch actor details to get pictureUrl
    useEffect(() => {
        if (!app || !actorName || pictureUrl !== undefined) return;

        const fetchActorDetails = async () => {
            try {
                const response = await app.callServerTool({
                    name: 'fetch-actor-details',
                    arguments: { actor: actorName },
                });

                const actorInfo = (response?.structuredContent as { actorInfo?: { pictureUrl?: string } } | undefined)
                    ?.actorInfo;
                if (actorInfo) setPictureUrl(actorInfo.pictureUrl);
            } catch (err) {
                console.error('[ActorRun] Failed to fetch actor details:', err);
            }
        };

        fetchActorDetails();
    }, [actorName, pictureUrl, app]);

    // Auto-polling: Fetch status updates automatically with gradual escalation
    useEffect(() => {
        if (!app || !run?.output.runId) return;
        if (TERMINAL_STATUSES.has(status)) return;

        const current = run;
        let isCancelled = false;
        let pollCount = 0;
        let consecutiveErrors = 0;

        // Gradual escalation: 5s, 5s, 10s, 10s, 15s, 15s... (max 60s)
        const getNextDelay = (count: number): number => {
            const baseDelay = Math.floor(count / 2) * 5 + 5;
            return Math.min(baseDelay * 1000, 60000);
        };

        const pollStatus = async () => {
            while (!isCancelled) {
                await delay(getNextDelay(pollCount));
                if (isCancelled) break;

                try {
                    // waitSecs: 0 keeps each refresh non-blocking; the widget polls on its own cadence.
                    const response = await app.callServerTool({
                        name: 'get-actor-run',
                        arguments: { runId: current.output.runId, waitSecs: 0 },
                    });

                    if (response.structuredContent) {
                        const newOutput = response.structuredContent as ActorRunOutput;
                        const updated: RunSnapshot = {
                            // Keep the known name when the response omits actorName, so a transient
                            // actor-name lookup miss doesn't flip the widget to "Unknown Actor".
                            output: newOutput.actorName
                                ? newOutput
                                : { ...newOutput, actorName: current.output.actorName },
                            costUsd: extractUsageTotalUsd(response._meta as ActorRunMeta),
                        };

                        // Skip the state update when nothing visible changed; otherwise every poll
                        // forces a re-render with identical data.
                        const previousDataset = getDataset(current.output);
                        const updatedDataset = getDataset(updated.output);
                        if (
                            updated.output.status !== current.output.status ||
                            updated.output.finishedAt !== current.output.finishedAt ||
                            updatedDataset?.id !== previousDataset?.id ||
                            updatedDataset?.itemCount !== previousDataset?.itemCount ||
                            updated.costUsd !== current.costUsd
                        ) {
                            setRun(updated);
                        }

                        const newStatus = (updated.output.status || '').toUpperCase();
                        if (TERMINAL_STATUSES.has(newStatus)) {
                            const ctx = [
                                `Actor run ${current.output.runId} finished with status: ${newStatus}.`,
                                updatedDataset?.id ? `Dataset ID: ${updatedDataset.id}` : null,
                                updatedDataset?.itemCount != null ? `Items scraped: ${updatedDataset.itemCount}` : null,
                            ]
                                .filter(Boolean)
                                .join(' ');
                            await app.updateModelContext({ content: [{ type: 'text', text: ctx }] }).catch(() => {});
                            break;
                        }
                    }
                    pollCount++;
                    consecutiveErrors = 0; // Reset error count on success
                } catch (err) {
                    console.error('[Auto-poll] Error:', err);
                    consecutiveErrors++;

                    // Stop polling after 3 consecutive errors
                    if (consecutiveErrors >= 3) break;

                    // Stop polling on authentication errors
                    if (err instanceof Error && (err.message.includes('401') || err.message.includes('Unauthorized'))) {
                        break;
                    }
                }
            }
        };

        pollStatus();

        return () => {
            isCancelled = true;
        };
    }, [runId, status, app]);

    // No preview to load for a run that produced nothing.
    const hasNoItems = status === 'SUCCEEDED' && !dataset?.itemCount;

    return (
        <ActorRunWidget
            output={run?.output ?? null}
            errorMessage={toolErrorMessage}
            costUsd={run?.costUsd}
            pictureUrl={pictureUrl}
            previewItems={hasNoItems ? [] : previewItems}
        />
    );
};
