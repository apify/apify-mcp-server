import React, { useEffect, useRef, useState } from "react";
import styled from "styled-components";
import { Badge, Button, InlineSpinner, Spinner, Text, theme, WarningMessage } from "@apify/ui-library";
import { WidgetLayout } from "../../components/layout/WidgetLayout";
import { CheckIcon, CrossIcon } from "@apify/ui-icons";
import { useWidgetProps } from "../../hooks/use-widget-props";
import { useWidgetState } from "../../hooks/use-widget-state";
import { formatDuration } from "../../utils/formatting";

// Data interfaces
interface ActorRunData {
    runId: string;
    actorName: string;
    actorUsername: string;
    actorImageUrl?: string;
    status: string;
    cost?: number;
    timestamp: string;
    duration: string;
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
        previewItems: Record<string, any>[];
    };
}

interface ToolOutput extends Record<string, unknown> {
    runId?: string;
    actorName?: string;
    actorUsername?: string;
    actorImageUrl?: string;
    status?: string;
    startedAt?: string;
    finishedAt?: string;
    stats?: any;
    dataset?: any;
}

interface WidgetState extends Record<string, unknown> {
    isRefreshing?: boolean;
    lastUpdateTime?: number;
    runStatus?: string;
    datasetId?: string;
    itemCount?: number;
    runId?: string;
}

const TERMINAL_STATUSES = new Set(["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"]);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type BadgeVariant = "success" | "danger" | "primary_blue" | "neutral";


const getStatusVariant = (status: string): BadgeVariant => {
    switch (status.toUpperCase()) {
        case "SUCCEEDED":
            return "success";
        case "FAILED":
            return "danger";
        case "RUNNING":
            return "primary_blue";
        default:
            return "neutral";
    }
};

const getStatusVariantLeadingIcon = (status: string) => {
    switch (status.toUpperCase()) {
        case "SUCCEEDED":
            return CheckIcon;
        case "FAILED":
        case "ABORTED":
            return CrossIcon;
        case "RUNNING":
            return InlineSpinner;
        default:
            return undefined;
    }
};

// Styled Components
const Container = styled.div`
    display: flex;
    flex-direction: column;
    gap: ${theme.space.space8};
    width: 100%;
    background: ${theme.color.neutral.background};
    border: 1px solid ${theme.color.neutral.separatorSubtle};
    border-radius: ${theme.radius.radius12};
    padding: ${theme.space.space16};
`;

const ActorHeader = styled.div`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: ${theme.space.space12};
    width: 100%;
    min-height: 24px;
`;

// Temporary ActorAvatar component until it's available in ui-library
const ActorAvatarWrapper = styled.div<{ size: number }>`
    width: ${props => props.size}px;
    height: ${props => props.size}px;
    border-radius: ${theme.radius.radius4};
    border: 1px solid ${theme.color.neutral.border};
    overflow: hidden;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: ${theme.color.neutral.backgroundMuted};
`;

const ActorAvatarImage = styled.img`
    width: 100%;
    height: 100%;
    object-fit: cover;
`;

const ActorAvatarInitials = styled.div<{ size: number }>`
    font-size: ${props => Math.floor(props.size * 0.4)}px;
    font-weight: 600;
    color: ${theme.color.neutral.text};
    text-transform: uppercase;
`;


const ActorNameLink = styled.a`
    color: ${theme.color.neutral.text};
    text-decoration: underline;
    text-decoration-color: ${theme.color.neutral.text};
    cursor: pointer;
    ${theme.typography.shared.desktop.bodyMMedium};

    &:hover {
        color: ${theme.color.primary.action};
        text-decoration-color: ${theme.color.primary.action};
    }
`;

const MetadataRow = styled.div`
    display: flex;
    align-items: center;
    gap: ${theme.space.space8};
    flex-wrap: nowrap;
`;

const Divider = styled.span`
    color: ${theme.color.neutral.textMuted};
    font-size: 12px;
    transform: rotate(0deg);
    display: flex;
    align-items: center;
`;

const TableContainer = styled.div`
    width: 100%;
    overflow-x: auto;
    overflow-y: auto;
    border: 1px solid ${theme.color.neutral.separatorSubtle};
    border-radius: ${theme.radius.radius12};
    background: ${theme.color.neutral.background};
    position: relative;
    max-height: 265px;
`;

const TableGradientOverlay = styled.div`
    position: sticky;
    bottom: 0;
    left: 0;
    width: 100%;
    height: 86px;
    margin-top: -86px;
    background: linear-gradient(179.32deg, rgba(255, 255, 255, 0) 13.4%, rgb(255, 255, 255) 95.38%);
    pointer-events: none;
    border-radius: 0 0 ${theme.radius.radius12} ${theme.radius.radius12};
    z-index: 2;
`;

const Table = styled.table`
    width: 100%;
    border-collapse: collapse;
`;

const TableHeader = styled.thead`
    background: ${theme.color.neutral.backgroundMuted};
    position: sticky;
    top: 0;
    z-index: 1;
`;

const TableHeaderCell = styled.th`
    text-align: left;
    padding: ${theme.space.space8};
    ${theme.typography.shared.desktop.titleXs};
    color: ${theme.color.neutral.textMuted};
    white-space: nowrap;
    border-right: 1px solid ${theme.color.neutral.separatorSubtle};
    border-bottom: 1px solid ${theme.color.neutral.separatorSubtle};

    &:last-child {
        border-right: none;
    }
`;

const TableBody = styled.tbody``;

const TableRow = styled.tr`
    border-bottom: 1px solid ${theme.color.neutral.separatorSubtle};

    &:last-child {
        border-bottom: none;
    }
`;

const TableCell = styled.td`
    padding: ${theme.space.space10} ${theme.space.space16};
    color: ${theme.color.neutral.textMuted};
    ${theme.typography.shared.desktop.bodyMMedium};
    max-width: 240px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    border-right: 1px solid ${theme.color.neutral.separatorSubtle};
    background: ${theme.color.neutral.background};

    &:last-child {
        border-right: none;
    }
`;

const Footer = styled.div`
    display: flex;
    align-items: center;
`;

export const ActorRun: React.FC = () => {
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
            const startedAt = toolOutput.startedAt as string;
            const finishedAt = toolOutput.finishedAt;
            const duration = formatDuration(startedAt, finishedAt);

            setRunData({
                runId: toolOutput.runId,
                actorName: (toolOutput.actorName as string) || "Unknown Actor",
                actorUsername: (toolOutput.actorUsername as string) || "unknown",
                actorImageUrl: toolOutput.actorImageUrl as string | undefined,
                status: (toolOutput.status as string) || "RUNNING",
                startedAt,
                finishedAt,
                timestamp: new Date(startedAt).toLocaleString(),
                duration,
                cost: toolOutput.stats?.computeUnits,
                stats: toolOutput.stats,
                dataset: toolOutput.dataset,
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
                    const response = await window.openai.callTool('get-actor-run', {
                        runId: runData.runId,
                    });

                    if (response.structuredContent) {
                        const newData = response.structuredContent as unknown as ToolOutput;
                        const startedAt = newData.startedAt as string;
                        const finishedAt = newData.finishedAt;
                        const duration = formatDuration(startedAt, finishedAt);

                        const updatedRunData: ActorRunData = {
                            runId: newData.runId!,
                            actorName: (newData.actorName as string) || runData.actorName,
                            actorUsername: (newData.actorUsername as string) || runData.actorUsername,
                            actorImageUrl: (newData.actorImageUrl as string | undefined) || runData.actorImageUrl,
                            status: (newData.status as string) || "RUNNING",
                            startedAt,
                            finishedAt,
                            timestamp: new Date(startedAt).toLocaleString(),
                            duration,
                            cost: newData.stats?.computeUnits,
                            stats: newData.stats,
                            dataset: newData.dataset,
                        };

                        setRunData(updatedRunData);

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
    }, [runData?.runId, runData?.status]);


    if (!runData) {
        return (
            <WidgetLayout>
                <Container>
                    <div style={{
                        padding: `${theme.space.space24} ${theme.space.space16}`,
                        textAlign: 'center',
                        color: theme.color.neutral.textMuted,
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        gap: theme.space.space8
                    }}>
                        <InlineSpinner />
                        <Text type="body" size="small" style={{ color: theme.color.neutral.textMuted }}>
                            Loading actor run data...
                        </Text>
                    </div>
                </Container>
            </WidgetLayout>
        );
    }

    // Extract table columns from first item
    const columns = runData.dataset?.previewItems.length
        ? Object.keys(runData.dataset.previewItems[0])
        : [];


    const handleOpenRun = () => {
        if (runData && window.openai?.openExternal) {
            window.openai.openExternal({
                href: `https://console.apify.com/actors/runs/${runData.runId}`,
            });
        }
    };

    const handleOpenActor = () => {
        if (runData && window.openai?.openExternal) {
            window.openai.openExternal({
                href: `https://console.apify.com/actors/${runData.actorUsername}/${runData.actorName}`,
            });
        }
    };

    // const handleRefreshStatus = async () => {
    //     if (!runData || !window.openai?.callTool) return;

    //     const snapshot: WidgetState = { ...widgetState, isRefreshing: true };
    //     await setWidgetState(snapshot);

    //     try {
    //         // Single poll only - auto-polling handles continuous updates
    //         const response = await window.openai.callTool("get-actor-run", {
    //             runId: runData.runId,
    //         });

    //         if (response.structuredContent) {
    //             setRunData(response.structuredContent as unknown as ActorRunData);
    //             await setWidgetState({ ...snapshot, lastUpdateTime: Date.now(), isRefreshing: false });
    //         }
    //     } catch (err) {
    //         console.error("Failed to fetch actor run status:", err);
    //         setError("Failed to fetch status update");
    //     } finally {
    //         await setWidgetState({ ...widgetState, isRefreshing: false });
    //     }
    // };

    if (error) {
        return (
            <WidgetLayout>
                <WarningMessage caption="Error">
                    {error}
                </WarningMessage>
            </WidgetLayout>
        );
    }

    return (
        <WidgetLayout>
            {/* Main Container */}
            <Container>
                {/* Actor Header */}
                <ActorHeader>
                    <div style={{ display: 'flex', alignItems: 'center', gap: theme.space.space16, height: 24 }}>
                        {/* Actor Type with Icon */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: theme.space.space6 }}>
                            <ActorAvatarWrapper size={20}>
                                {runData.actorImageUrl ? (
                                    <ActorAvatarImage src={runData.actorImageUrl} alt={runData.actorName} />
                                ) : (
                                    <ActorAvatarInitials size={20}>
                                        {runData.actorName.charAt(0)}
                                    </ActorAvatarInitials>
                                )}
                            </ActorAvatarWrapper>

                            <ActorNameLink onClick={handleOpenActor}>
                                {runData.actorName}
                            </ActorNameLink>
                        </div>

                        {/* Status Badge and Metadata */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: theme.space.space16, flexWrap: 'nowrap', overflow: 'hidden', flex: 1}}>
                            {/* Status Badge */}
                            <Badge variant={getStatusVariant(runData.status)} size="small" LeadingIcon={getStatusVariantLeadingIcon(runData.status)}>
                                {runData.status.charAt(0) + runData.status.slice(1).toLowerCase()}
                            </Badge>

                            {/* Metadata */}
                            <MetadataRow>
                                {typeof runData.cost === 'number' && (
                                    <>
                                        <Text type="body" size="small" as="span" style={{ color: theme.color.neutral.text, fontWeight: 500 }}>
                                            ${runData.cost.toFixed(3)}
                                        </Text>
                                        <Divider>|</Divider>
                                    </>
                                )}

                                <Text type="body" size="small" as="span" style={{ color: theme.color.neutral.text, fontWeight: 500 }}>
                                    {runData.timestamp}
                                </Text>

                                <Divider>|</Divider>

                                <Text type="body" size="small" as="span" style={{ color: theme.color.neutral.text, fontWeight: 500 }}>
                                    {runData.duration}
                                </Text>
                            </MetadataRow>
                        </div>
                    </div>

                    {/* TODO (KH): add expand view in next step */}
                    {/* <IconButton Icon={ExpandIcon} onClick={() => setIsExpanded(!isExpanded)} /> */}
                </ActorHeader>

                {/* Results Table or Status Message */}
                {runData.dataset && runData.dataset.previewItems.length > 0 ? (
                    <TableContainer>
                        <Table>
                            <TableHeader>
                                <tr>
                                    {columns.map((column) => (
                                        <TableHeaderCell key={column}>
                                            {column.charAt(0).toUpperCase() + column.slice(1)}
                                        </TableHeaderCell>
                                    ))}
                                </tr>
                            </TableHeader>
                            <TableBody>
                                {runData.dataset.previewItems.map((item, index) => (
                                    <TableRow key={index}>
                                        {columns.map((column) => (
                                            <TableCell key={column}>
                                                {item[column]?.toString() || "—"}
                                            </TableCell>
                                        ))}
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                        <TableGradientOverlay />
                    </TableContainer>
                ) : (
                    <div style={{
                        padding: `${theme.space.space24} ${theme.space.space16}`,
                        textAlign: 'center',
                        color: theme.color.neutral.textMuted,
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        gap: theme.space.space8
                    }}>
                        {runData.status.toUpperCase() === 'RUNNING' ? (
                            <>
                                <Text type="body" size="small" style={{ color: theme.color.neutral.textMuted }}>
                                    Actor is running... Results will appear when available.
                                </Text>
                            </>
                        ) : (
                            <Text type="body" size="small" style={{ color: theme.color.neutral.textMuted }}>
                                No results available
                            </Text>
                        )}
                    </div>
                )}

                {/* Footer */}
                <Footer>
                    <Button onClick={handleOpenRun} variant="secondary" size="small">
                        View in Console
                    </Button>
                </Footer>
            </Container>
        </WidgetLayout>
    );
};
