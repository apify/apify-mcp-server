import React, { useEffect, useMemo, useState } from "react";
import { useWidgetProps } from "../../hooks/use-widget-props";
import { useWidgetState } from "../../hooks/use-widget-state";
import { WidgetLayout } from "../../components/layout/WidgetLayout";
import { formatDuration, formatBytes } from "../../utils/formatting";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Alert } from "../../components/ui/Alert";
import { Heading } from "../../components/ui/Heading";
import { ProgressBar } from "../../components/ui/ProgressBar";
import { JsonPreview } from "../../components/ui/JsonPreview";
import { Text } from "../../components/ui/Text";
import { Card } from "../../components/ui/Card";
import { ActorRunSkeleton } from "./ActorRun.skeleton";

interface ActorRunData {
    runId: string;
    actorName: string;
    status: string;
    startedAt: string;
    finishedAt?: string;
    stats?: {
        computeUnits?: number;
        memoryAvgBytes?: number;
        memoryMaxBytes?: number;
    };
    dataset?: {
        datasetId: string;
        itemCount: number;
        schema: any;
        previewItems: any[];
    };
    input?: any;
}

interface ToolOutput extends Record<string, unknown> {
    runId?: string;
    actorName?: string;
    status?: string;
    startedAt?: string;
    finishedAt?: string;
    stats?: any;
    dataset?: any;
    input?: any;
}

interface WidgetState extends Record<string, unknown> {
    isRefreshing?: boolean;
    lastUpdateTime?: number;
}

type StatusVariant = "success" | "danger" | "warning" | "secondary";

const TERMINAL_STATUSES = new Set(["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"]);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const getStatusVariant = (status: string): StatusVariant => {
    switch ((status || "").toUpperCase()) {
        case "SUCCEEDED":
            return "success";
        case "FAILED":
        case "ABORTED":
        case "TIMED-OUT":
            return "danger";
        case "RUNNING":
            return "warning";
        default:
            return "secondary";
    }
};

export const ActorRun: React.FC = () => {
    const toolOutput = useWidgetProps<ToolOutput>();

    const [widgetState, setWidgetState] = useWidgetState<WidgetState>({
        isRefreshing: false,
        lastUpdateTime: Date.now(),
    });

    const [runData, setRunData] = useState<ActorRunData | null>(null);
    const [error, setError] = useState<string | null>(null);

    // Initialize from toolOutput once
    useEffect(() => {
        if (toolOutput?.runId && !runData) {
            setRunData({
                runId: toolOutput.runId,
                actorName: toolOutput.actorName as string,
                status: (toolOutput.status as string) || "RUNNING",
                startedAt: toolOutput.startedAt as string,
                finishedAt: toolOutput.finishedAt,
                stats: toolOutput.stats,
                dataset: toolOutput.dataset,
                input: toolOutput.input,
            });
        }
    }, [toolOutput, runData]);

    // Auto-polling: Fetch status updates automatically with gradual escalation
    useEffect(() => {
        if (!runData?.runId || !window.openai?.callTool) return;

        const status = (runData.status || '').toUpperCase();
        if (TERMINAL_STATUSES.has(status)) return;

        let isCancelled = false;
        let pollCount = 0;

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
                    const response = await window.openai.callTool('get-actor-run', {
                        runId: runData.runId,
                    });

                    if (response.structuredContent) {
                        const newData = response.structuredContent as unknown as ActorRunData;
                        setRunData(newData);

                        const newStatus = (newData.status || '').toUpperCase();
                        if (TERMINAL_STATUSES.has(newStatus)) break;
                    }

                    pollCount++;
                } catch (err) {
                    console.error('[Auto-poll] Error:', err);
                }
            }
        };

        pollStatus();

        return () => {
            isCancelled = true;
        };
    }, [runData?.runId]);

    const flags = useMemo(() => {
        const status = (runData?.status || "").toUpperCase();
        const isRunning = status === "RUNNING";
        const isSucceeded = status === "SUCCEEDED";
        const isFailed = ["FAILED", "ABORTED", "TIMED-OUT"].includes(status);
        const isCompleted = isSucceeded || isFailed;
        return { status, isRunning, isSucceeded, isFailed, isCompleted };
    }, [runData?.status]);

    const handleOpenRun = () => {
        if (runData && window.openai?.openExternal) {
            window.openai.openExternal({
                href: `https://console.apify.com/actors/runs/${runData.runId}`,
            });
        }
    };

    const handleOpenDataset = () => {
        if (runData?.dataset && window.openai?.openExternal) {
            window.openai.openExternal({
                href: `https://console.apify.com/storage/datasets/${runData.dataset.datasetId}`,
            });
        }
    };

    const handleRefreshStatus = async () => {
        if (!runData || !window.openai?.callTool) return;

        const snapshot: WidgetState = { ...widgetState, isRefreshing: true };
        await setWidgetState(snapshot);

        try {
            // Single poll only - auto-polling handles continuous updates
            const response = await window.openai.callTool("get-actor-run", {
                runId: runData.runId,
            });

            if (response.structuredContent) {
                setRunData(response.structuredContent as unknown as ActorRunData);
                await setWidgetState({ ...snapshot, lastUpdateTime: Date.now(), isRefreshing: false });
            }
        } catch (err) {
            console.error("Failed to fetch actor run status:", err);
            setError("Failed to fetch status update");
        } finally {
            await setWidgetState({ ...widgetState, isRefreshing: false });
        }
    };

    if (error) {
        return (
            <WidgetLayout>
                <Alert variant="error" title="Error">
                    {error}
                </Alert>
            </WidgetLayout>
        );
    }

    if (!runData) {
        return (
            <WidgetLayout>
                <ActorRunSkeleton />
            </WidgetLayout>
        );
    }

    return (
        <WidgetLayout>
            <Card variant="alt" padding="lg" className="flex flex-col gap-4 w-full">
                <RunHeader
                    actorName={runData.actorName}
                    status={runData.status}
                    isCompleted={flags.isCompleted}
                    isRefreshing={!!widgetState?.isRefreshing}
                    onRefresh={handleRefreshStatus}
                    onOpenRun={handleOpenRun}
                />

                <RunStats startedAt={runData.startedAt} finishedAt={runData.finishedAt} stats={runData.stats} />

                {flags.isRunning && <ProgressBar variant="warning" />}

                {flags.isSucceeded && runData.dataset ? <RunResults dataset={runData.dataset} onOpenDataset={handleOpenDataset} /> : null}

                {flags.isFailed ? <RunFailure /> : null}

                <RunIdFooter runId={runData.runId} />
            </Card>
        </WidgetLayout>
    );
};

const RunHeader: React.FC<{
    actorName: string;
    status: string;
    isCompleted: boolean;
    isRefreshing: boolean;
    onRefresh: () => void;
    onOpenRun: () => void;
}> = ({ actorName, status, isCompleted, isRefreshing, onRefresh, onOpenRun }) => {
    const isRunning = (status || '').toUpperCase() === 'RUNNING';

    return (
        <div className="flex items-start justify-between w-full gap-4">
            <div className="flex-1 min-w-0">
                <Heading size="xl" className="mb-1">
                    {actorName}
                </Heading>

                <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant={getStatusVariant(status)}>{status}</Badge>

                    {isRunning && (
                        <Badge variant="secondary">
                            <span className="flex items-center gap-1.5">
                                <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></span>
                                Auto-refreshing
                            </span>
                        </Badge>
                    )}

                    {!isCompleted && (
                        <Button onClick={onRefresh} disabled={isRefreshing} loading={isRefreshing} variant="secondary" size="sm">
                            {isRefreshing ? "Loading..." : "Get Status"}
                        </Button>
                    )}
                </div>
            </div>

            <Button onClick={onOpenRun} variant="primary" size="md">
                View in Console
            </Button>
        </div>
    );
};

const RunStats: React.FC<{
    startedAt: string;
    finishedAt?: string;
    stats?: ActorRunData["stats"];
}> = ({ startedAt, finishedAt, stats }) => {
    return (
        <div className="flex flex-wrap gap-4">
            <StatItem label="Runtime" value={formatDuration(startedAt, finishedAt)} />

            {typeof stats?.computeUnits === "number" && <StatItem label="Compute Units" value={stats.computeUnits.toFixed(4)} />}

            {typeof stats?.memoryMaxBytes === "number" && <StatItem label="Max Memory" value={formatBytes(stats.memoryMaxBytes)} />}
        </div>
    );
};

const RunResults: React.FC<{
    dataset: NonNullable<ActorRunData["dataset"]>;
    onOpenDataset: () => void;
}> = ({ dataset, onOpenDataset }) => {
    const previewCount = Array.isArray(dataset.previewItems) ? dataset.previewItems.length : 0;

    return (
        <Alert variant="success" title="✓ Results Ready">
            <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                    <Text as="div" size="sm" tone="secondary" className="flex items-center gap-2">
                        <span>{dataset.itemCount} items</span>
                        <Text as="span" size="sm" tone="tertiary">
                            •
                        </Text>
                        <span>Dataset ID: {dataset.datasetId}</span>
                    </Text>

                    <Button onClick={onOpenDataset} variant="primary" size="sm">
                        View Dataset
                    </Button>
                </div>

                {previewCount > 0 && <JsonPreview value={dataset.previewItems} title={`Preview (first ${previewCount} items)`} />}
            </div>
        </Alert>
    );
};

const RunFailure: React.FC = () => {
    return (
        <Alert variant="error" title="Run Failed">
            The Actor run did not complete successfully. Check the console for details.
        </Alert>
    );
};

const RunIdFooter: React.FC<{ runId: string }> = ({ runId }) => {
    return (
        <Text as="div" size="xs" tone="tertiary" className="flex items-center gap-2 pt-2 border-t border-[var(--color-border)]">
            <span>Run ID:</span>
            <code className="px-2 py-0.5 rounded bg-[var(--color-code-bg)]">
                {runId}
            </code>
        </Text>
    );
};

const StatItem: React.FC<{ label: string; value: string | number }> = ({ label, value }) => {
    return (
        <div className="flex flex-col gap-1">
            <Text as="span" size="xs" tone="secondary">
                {label}
            </Text>
            <Text as="span" size="sm" weight="medium">
                {value}
            </Text>
        </div>
    );
};
