import React, { useEffect, useMemo, useRef, useState } from "react";
import styled from "styled-components";
import { Badge, Button, CodeBlock, Message, Text, theme } from "@apify/ui-library";
import { useWidgetProps } from "../../hooks/use-widget-props";
import { useWidgetState } from "../../hooks/use-widget-state";
import { WidgetLayout } from "../../components/layout/WidgetLayout";
import { formatDuration, formatBytes } from "../../utils/formatting";
import { ProgressBar } from "../../components/ui/ProgressBar";
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
    runStatus?: string;
    datasetId?: string;
    itemCount?: number;
    runId?: string;
}

type BadgeVariant = "success" | "danger" | "warning" | "neutral";

const TERMINAL_STATUSES = new Set(["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"]);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const getStatusVariant = (status: string): BadgeVariant => {
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
            return "neutral";
    }
};

const Container = styled.div`
    display: flex;
    flex-direction: column;
    gap: ${theme.space.space16};
    width: 100%;
    background: ${theme.color.neutral.background};
    border-radius: ${theme.radius.radius12};
    padding: ${theme.space.space24};
`;

const HeaderWrapper = styled.div`
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    gap: ${theme.space.space16};
`;

const BadgeGroup = styled.div`
    display: flex;
    align-items: center;
    gap: ${theme.space.space8};
    flex-wrap: wrap;
`;

const ConsoleButton = styled(Button)`
    height: 40px;
`;

const StatusDot = styled.span`
    display: inline-block;
    width: ${theme.space.space6};
    height: ${theme.space.space6};
    border-radius: ${theme.radius.radiusFull};
    background: ${theme.color.primary.action};
    animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;

    @keyframes pulse {
        0%, 100% {
            opacity: 1;
        }
        50% {
            opacity: 0.5;
        }
    }
`;

const StatsGrid = styled.div`
    display: flex;
    gap: ${theme.space.space24};
    flex-wrap: wrap;
`;

const StatItemWrapper = styled.div`
    display: flex;
    flex-direction: column;
    gap: ${theme.space.space4};
`;

const ResultsContainer = styled.div`
    background: ${theme.color.success.backgroundSubtle};
    border-radius: ${theme.radius.radius8};
    padding: ${theme.space.space16};
    display: flex;
    flex-direction: column;
    gap: ${theme.space.space12};
`;

const ResultsHeader = styled.div`
    display: flex;
    align-items: center;
    gap: ${theme.space.space8};
`;

const ResultsMetadata = styled.div`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: ${theme.space.space12};
    flex-wrap: wrap;
`;

const MetadataGroup = styled.div`
    display: flex;
    align-items: center;
    gap: ${theme.space.space8};
`;

const RunIdFooterWrapper = styled.div`
    display: flex;
    align-items: center;
    gap: ${theme.space.space8};
    padding-top: ${theme.space.space12};
    border-top: 1px solid ${theme.color.neutral.separatorSubtle};
`;

const CodeWrapper = styled.code`
    padding: ${theme.space.space2} ${theme.space.space6};
    border-radius: ${theme.radius.radius4};
    background: ${theme.color.neutral.backgroundMuted};
    color: ${theme.color.neutral.text};
    font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
    font-size: 12px;
`;

export const ActorRunOld: React.FC = () => {
    const toolOutput = useWidgetProps<ToolOutput>();

    const [widgetState, setWidgetState] = useWidgetState<WidgetState>({
        isRefreshing: false,
        lastUpdateTime: Date.now(),
    });
    const widgetStateRef = useRef(widgetState);

    const [runData, setRunData] = useState<ActorRunData | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        widgetStateRef.current = widgetState;
    }, [widgetState]);

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
                        if (TERMINAL_STATUSES.has(newStatus)) {
                            // Notify model that run is complete by updating widget state
                            await setWidgetState({
                                ...widgetStateRef.current,
                                runStatus: newStatus,
                                runId: runData.runId,
                                datasetId: newData.dataset?.datasetId,
                                itemCount: newData.dataset?.itemCount,
                                lastUpdateTime: Date.now(),
                            });
                            break;
                        }
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
                <Message type="danger" caption="Error">
                    {error}
                </Message>
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
            <Container>
                <RunHeader
                    status={runData.status}
                    isCompleted={flags.isCompleted}
                    isRefreshing={!!widgetState?.isRefreshing}
                    onRefresh={handleRefreshStatus}
                    onOpenRun={handleOpenRun}
                />

                <RunStats startedAt={runData.startedAt} finishedAt={runData.finishedAt} stats={runData.stats} />

                {flags.isRunning && <ProgressBar variant="warning" />}

                {flags.isSucceeded && runData.dataset ? (
                    <RunResults dataset={runData.dataset} onOpenDataset={handleOpenDataset} />
                ) : null}

                {flags.isFailed ? <RunFailure /> : null}

                <RunIdFooter runId={runData.runId} />
            </Container>
        </WidgetLayout>
    );
};

const RunHeader: React.FC<{
    status: string;
    isCompleted: boolean;
    isRefreshing: boolean;
    onRefresh: () => void;
    onOpenRun: () => void;
}> = ({ status, isCompleted, isRefreshing, onRefresh, onOpenRun }) => {
    const isRunning = (status || '').toUpperCase() === 'RUNNING';

    return (
        <HeaderWrapper>
            <BadgeGroup>
                <Badge variant={getStatusVariant(status)} size="small">
                    {status}
                </Badge>

                {isRunning && (
                    <Badge variant="neutral_muted" size="small">
                        <StatusDot />
                        <Text type="body" size="small" weight="medium" as="span">
                            Auto-refreshing
                        </Text>
                    </Badge>
                )}

                {!isCompleted && (
                    <Button onClick={onRefresh} disabled={isRefreshing} variant="secondary" size="small">
                        {isRefreshing ? "Loading..." : "Get Status"}
                    </Button>
                )}
            </BadgeGroup>

            <ConsoleButton onClick={onOpenRun} variant="secondary" size="medium">
                View in Console
            </ConsoleButton>
        </HeaderWrapper>
    );
};

const RunStats: React.FC<{
    startedAt: string;
    finishedAt?: string;
    stats?: ActorRunData["stats"];
}> = ({ startedAt, finishedAt, stats }) => {
    return (
        <StatsGrid>
            <StatItem label="Runtime" value={formatDuration(startedAt, finishedAt)} />

            {typeof stats?.computeUnits === "number" && <StatItem label="Compute Units" value={stats.computeUnits.toFixed(4)} />}

            {typeof stats?.memoryMaxBytes === "number" && <StatItem label="Max Memory" value={formatBytes(stats.memoryMaxBytes)} />}
        </StatsGrid>
    );
};

const RunResults: React.FC<{
    dataset: NonNullable<ActorRunData["dataset"]>;
    onOpenDataset: () => void;
}> = ({ dataset, onOpenDataset }) => {
    const previewCount = Array.isArray(dataset.previewItems) ? dataset.previewItems.length : 0;

    return (
        <ResultsContainer>
            <ResultsMetadata>
                <ResultsHeader>
                    <Text type="body" size="regular" weight="medium" as="span" style={{ color: theme.color.success.text }}>
                        ✓ Results Ready
                    </Text>
                </ResultsHeader>

                <Button onClick={onOpenDataset} variant="secondary" size="small">
                    View Dataset
                </Button>
            </ResultsMetadata>

            <MetadataGroup>
                <Text type="body" size="small" as="span" style={{ color: theme.color.neutral.textMuted }}>
                    {dataset.itemCount} items
                </Text>
                <Text type="body" size="small" as="span" style={{ color: theme.color.neutral.textSubtle }}>
                    •
                </Text>
                <Text type="body" size="small" as="span" style={{ color: theme.color.neutral.textMuted }}>
                    Dataset ID: {dataset.datasetId}
                </Text>
            </MetadataGroup>

            {previewCount > 0 && (
                <div>
                    <Text type="body" size="small" weight="medium" as="div" mb="space8" style={{ color: theme.color.neutral.text }}>
                        Preview (first {previewCount} items)
                    </Text>
                    <CodeBlock
                        content={JSON.stringify(dataset.previewItems, null, 2)}
                        language="json"
                        hideLineNumbers={true}
                        size="small"
                    />
                </div>
            )}
        </ResultsContainer>
    );
};

const RunFailure: React.FC = () => {
    return (
        <Message type="danger" caption="Run Failed">
            The Actor run did not complete successfully. Check the console for details.
        </Message>
    );
};

const RunIdFooter: React.FC<{ runId: string }> = ({ runId }) => {
    return (
        <RunIdFooterWrapper>
            <Text type="body" size="small" as="span" style={{ color: theme.color.neutral.textMuted }}>
                Run ID:
            </Text>
            <CodeWrapper>{runId}</CodeWrapper>
        </RunIdFooterWrapper>
    );
};

const StatItem: React.FC<{ label: string; value: string | number }> = ({ label, value }) => {
    return (
        <StatItemWrapper>
            <Text type="body" size="small" as="span" style={{ color: theme.color.neutral.textMuted }}>
                {label}
            </Text>
            <Text type="body" size="regular" weight="medium" as="span">
                {value}
            </Text>
        </StatItemWrapper>
    );
};
