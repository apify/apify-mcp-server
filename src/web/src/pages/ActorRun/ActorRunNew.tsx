import React, { useState } from "react";
import styled from "styled-components";
import { Badge, Button, Text, theme } from "@apify/ui-library";
import { WidgetLayout } from "../../components/layout/WidgetLayout";

// Mock data structure
interface ActorRunData {
    runId: string;
    actorName: string;
    actorUsername: string;
    actorImageUrl?: string;
    status: "SUCCEEDED" | "FAILED" | "RUNNING";
    cost: number;
    timestamp: string;
    duration: string;
    dataset?: {
        datasetId: string;
        itemCount: number;
        previewItems: Record<string, any>[];
    };
}

// Mock data
const MOCK_DATA: ActorRunData = {
    runId: "run_abc123",
    actorName: "Website Content Crawler",
    actorUsername: "apify",
    status: "SUCCEEDED",
    cost: 0.014,
    timestamp: "2025-01-09 14:31",
    duration: "59s",
    dataset: {
        datasetId: "dataset_xyz789",
        itemCount: 200,
        previewItems: [
            {
                title: "Tweet Scraper",
                name: "tweet-scraper",
                username: "apidojo",
                stats: "12 fields",
                description: "⚡ Lightning-fast Twitter scraper"
            },
            {
                title: "Google Maps Scraper",
                name: "crawler-google-places",
                username: "compass",
                stats: "12 fields",
                description: "Extract data from Google Maps"
            },
            {
                title: "Website Content Crawler",
                name: "website-content-crawler",
                username: "apify",
                stats: "12 fields",
                description: "Extract content from websites"
            },
            {
                title: "TikTok Scraper",
                name: "tiktok-scraper",
                username: "clockworks",
                stats: "8 fields",
                description: "Scrape TikTok videos and profiles"
            }
        ]
    }
};

type BadgeVariant = "success" | "danger" | "warning" | "neutral";

const getStatusVariant = (status: string): BadgeVariant => {
    switch (status.toUpperCase()) {
        case "SUCCEEDED":
            return "success";
        case "FAILED":
            return "danger";
        case "RUNNING":
            return "warning";
        default:
            return "neutral";
    }
};

// Styled Components
const NotificationBar = styled.div`
    background: ${theme.color.neutral.backgroundSubtle};
    border: 1px solid ${theme.color.neutral.textSubtle};
    border-radius: ${theme.radius.radius8};
    padding: ${theme.space.space12} ${theme.space.space16};
    margin-bottom: ${theme.space.space16};
`;

const Container = styled.div`
    display: flex;
    flex-direction: column;
    gap: ${theme.space.space16};
    width: 100%;
    background: ${theme.color.neutral.background};
    border: 1px solid ${theme.color.neutral.textSubtle};
    border-radius: ${theme.radius.radius8};
    padding: ${theme.space.space16};
`;

const ActorHeader = styled.div`
    display: flex;
    align-items: center;
    gap: ${theme.space.space12};
`;

const ActorIconWrapper = styled.div`
    width: 32px;
    height: 32px;
    border-radius: ${theme.radius.radius6};
    background: ${theme.color.neutral.backgroundMuted};
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
`;

const ActorIcon = styled.div`
    width: 24px;
    height: 24px;
    background: linear-gradient(135deg, ${theme.color.primary.action} 0%, ${theme.color.primary.actionHover} 100%);
    border-radius: ${theme.radius.radius4};
`;

const ActorNameLink = styled.a`
    color: ${theme.color.neutral.text};
    text-decoration: underline;
    cursor: pointer;

    &:hover {
        color: ${theme.color.primary.action};
    }
`;

const MetadataRow = styled.div`
    display: flex;
    align-items: center;
    gap: ${theme.space.space12};
    flex-wrap: wrap;
`;

const Divider = styled.span`
    color: ${theme.color.neutral.textMuted};
`;

const ExpandButton = styled.button`
    margin-left: auto;
    background: transparent;
    border: none;
    color: ${theme.color.neutral.textMuted};
    cursor: pointer;
    padding: ${theme.space.space4};
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: ${theme.radius.radius4};

    &:hover {
        background: ${theme.color.neutral.backgroundSubtle};
        color: ${theme.color.neutral.text};
    }
`;

const TableContainer = styled.div`
    width: 100%;
    overflow-x: auto;
    border: 1px solid ${theme.color.neutral.textSubtle};
    border-radius: ${theme.radius.radius8};
`;

const Table = styled.table`
    width: 100%;
    border-collapse: collapse;
`;

const TableHeader = styled.thead`
    background: ${theme.color.neutral.backgroundSubtle};
    border-bottom: 1px solid ${theme.color.neutral.textSubtle};
`;

const TableHeaderCell = styled.th`
    text-align: left;
    padding: ${theme.space.space12} ${theme.space.space16};
    font-weight: 500;
    color: ${theme.color.neutral.textMuted};
    white-space: nowrap;
    border-right: 1px solid ${theme.color.neutral.separatorSubtle};

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

    &:hover {
        background: ${theme.color.neutral.backgroundSubtle};
    }
`;

const TableCell = styled.td`
    padding: ${theme.space.space12} ${theme.space.space16};
    color: ${theme.color.neutral.text};
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    border-right: 1px solid ${theme.color.neutral.separatorSubtle};

    &:last-child {
        border-right: none;
    }
`;

const Footer = styled.div`
    display: flex;
    flex-direction: column;
    gap: ${theme.space.space12};
    padding-top: ${theme.space.space12};
    align-items: flex-start;
`;

export const ActorRunNew: React.FC = () => {
    console.log('[ActorRunNew] Component rendering');
    const [runData] = useState<ActorRunData>(MOCK_DATA);
    const [isExpanded, setIsExpanded] = useState(false);

    console.log('[ActorRunNew] runData:', runData);

    const handleOpenConsole = () => {
        if (window.openai?.openExternal) {
            window.openai.openExternal({
                href: `https://console.apify.com/actors/runs/${runData.runId}`,
            });
        }
    };

    const handleOpenActor = () => {
        if (window.openai?.openExternal) {
            window.openai.openExternal({
                href: `https://console.apify.com/actors/${runData.actorUsername}/${runData.actorName}`,
            });
        }
    };

    // Extract table columns from first item
    const columns = runData.dataset?.previewItems.length
        ? Object.keys(runData.dataset.previewItems[0])
        : [];

    return (
        <WidgetLayout>
            {/* Notification */}
            <NotificationBar>
                <Text type="body" size="regular" as="span">
                    Actor finished.
                </Text>
            </NotificationBar>

            {/* Main Container */}
            <Container>
                {/* Actor Header */}
                <ActorHeader>
                    <ActorIconWrapper>
                        <ActorIcon />
                    </ActorIconWrapper>

                    <ActorNameLink onClick={handleOpenActor}>
                        {runData.actorName}
                    </ActorNameLink>

                    <Badge variant={getStatusVariant(runData.status)} size="small">
                        {runData.status === "SUCCEEDED" && "✓ "}
                        {runData.status}
                    </Badge>

                    <Divider>•</Divider>

                    <Text type="body" size="small" as="span" style={{ color: theme.color.neutral.text }}>
                        ${runData.cost.toFixed(4)}
                    </Text>

                    <Divider>•</Divider>

                    <Text type="body" size="small" as="span" style={{ color: theme.color.neutral.textMuted }}>
                        {runData.timestamp}
                    </Text>

                    <Divider>•</Divider>

                    <Text type="body" size="small" as="span" style={{ color: theme.color.neutral.textMuted }}>
                        {runData.duration}
                    </Text>

                    <ExpandButton onClick={() => setIsExpanded(!isExpanded)}>
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                            <path d="M10 2H14V6M6 14H2V10M14 2L9 7M2 14L7 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                    </ExpandButton>
                </ActorHeader>

                {/* Results Table */}
                {runData.dataset && runData.dataset.previewItems.length > 0 && (
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
                    </TableContainer>
                )}

                {/* Footer */}
                <Footer>
                    <Button onClick={handleOpenConsole} variant="secondary" size="small">
                        View in Console
                    </Button>

                    {runData.dataset && (
                        <Text size="small" as="span" style={{ color: theme.color.neutral.text }}>
                            The crawler found {runData.dataset.itemCount} results. You can visit results via the provided link.
                        </Text>
                    )}
                </Footer>
            </Container>
        </WidgetLayout>
    );
};
