import React, { useState, useEffect } from "react";
import styled from "styled-components";
import { useWidgetProps } from "../../hooks/use-widget-props";
import { useWidgetState } from "../../hooks/use-widget-state";
import { ActorSearchDetail } from "./ActorSearchDetail";
import { WidgetLayout } from "../../components/layout/WidgetLayout";
import { Message } from "@apify/ui-library";
import { ActorDetails, Actor } from "../../types";
import { ActorSearchDetailSkeleton, ActorSearchResultsSkeleton } from "./ActorSearch.skeleton";
import { theme, Text } from "@apify/ui-library";
import { StarEmptyIcon, PeopleIcon } from "@apify/ui-icons";

// Styled components
const Container = styled.div`
    background: ${theme.color.neutral.backgroundSubtle};
    display: flex;
    flex-direction: column;
    gap: 2px;
    border-radius: 12px;
    padding: 2px;
    width: 100%;
`;

const Header = styled.div`
    display: flex;
    align-items: center;
    padding: ${theme.space.space4} ${theme.space.space4} ${theme.space.space4} ${theme.space.space8};
    border-radius: 12px 12px 0 0;
`;

const ActorCardContainer = styled.div`
    background: ${theme.color.neutral.background};
    border: 1px solid ${theme.color.neutral.separatorSubtle};
    border-radius: 6px;
    display: flex;
    flex-direction: column;
    gap: ${theme.space.space8};
    padding: ${theme.space.space12} ${theme.space.space16};
    box-shadow: ${theme.shadow.shadow1};
    width: 100%;
`;

const ActorHeader = styled.div`
    display: flex;
    gap: ${theme.space.space12};
    align-items: flex-start;
    width: 100%;
`;

const ActorIcon = styled.img`
    width: 40px;
    height: 40px;
    border-radius: 8px;
    border: 1px solid ${theme.color.neutral.separatorSubtle};
    object-fit: cover;
    flex-shrink: 0;
`;

const ActorInfo = styled.div`
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    min-width: 0;
    overflow: hidden;
`;

const ContentSection = styled.div`
    display: flex;
    flex-direction: column;
    gap: ${theme.space.space6};
    width: 100%;
`;

const MetadataRow = styled.div`
    display: flex;
    gap: ${theme.space.space8};
    align-items: center;
    padding: ${theme.space.space4} 0;
    width: 100%;
`;

const DeveloperInfo = styled.div`
    display: flex;
    gap: ${theme.space.space4};
    align-items: center;
`;

const DeveloperLogo = styled.img`
    width: 20px;
    height: 20px;
`;

const StatsContainer = styled.div`
    display: flex;
    gap: ${theme.space.space8};
    align-items: center;
`;

const StatItem = styled.div`
    display: flex;
    gap: 2px;
    align-items: center;
`;

const StatIcon = styled.div`
    width: 12px;
    height: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: ${theme.color.neutral.textMuted};
    flex-shrink: 0;
`;

const Divider = styled.div`
    width: 0;
    height: 8px;
    border-left: 1px solid ${theme.color.neutral.separatorSubtle};
`;

interface ToolOutput extends Record<string, unknown> {
    actors?: Actor[];
    query?: string;
    actorDetails?: ActorDetails;
}

interface WidgetState extends Record<string, unknown> {
    loadingDetails?: string | null;
    isLoading?: boolean;
    showDetails?: boolean;
    requestedActorId?: string | null;
}

export const ActorSearch: React.FC = () => {
    const toolOutput = useWidgetProps<ToolOutput>();

    const [widgetState, setWidgetState] = useWidgetState<WidgetState>({
        loadingDetails: null,
        isLoading: false,
        showDetails: false,
        requestedActorId: null,
    });

    const [localActorDetails, setLocalActorDetails] = useState<ActorDetails | null>(null);

    // Prefer widget format actors if available (for widget mode), otherwise use schema-compliant format
    const hasToolActorDetails = Boolean(toolOutput?.actorDetails);
    const actorsFromTool = (toolOutput as any)?.widgetActors || toolOutput?.actors;
    const actorDetails = toolOutput?.actorDetails || localActorDetails;
    const isFetchingDetails = Boolean(widgetState?.loadingDetails);
    const requestedActorId = widgetState?.requestedActorId;

    // When actorDetails is provided directly from tool (details-only call), ignore actors to force details view
    // This handles the case when fetch-actor-details is called directly (not from search)
    const actors = hasToolActorDetails ? [] : actorsFromTool || [];
    const shouldForceDetailsView = hasToolActorDetails;

    const showDetails = (widgetState?.showDetails || shouldForceDetailsView) && Boolean(actorDetails);
    const hasLoadedOnce = Boolean(toolOutput && ("actors" in toolOutput || "actorDetails" in toolOutput));
    const isInitialLoading = !hasLoadedOnce && !actorDetails;
    const shouldShowDetailSkeleton = (widgetState?.showDetails || requestedActorId || isFetchingDetails || shouldForceDetailsView)
        && !actorDetails;

    // When actorDetails is received directly from tool (not from button click), save it locally and show details view
    // This ensures the details persist even if toolOutput changes later
    useEffect(() => {
        if (hasToolActorDetails && toolOutput?.actorDetails) {
            // Save to local state immediately (same as button click does) so it persists
            setLocalActorDetails(toolOutput.actorDetails);
            // Set widget state to show details view
            if (!widgetState?.showDetails) {
                void setWidgetState({
                    ...widgetState,
                    showDetails: true,
                });
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [hasToolActorDetails, toolOutput?.actorDetails]);

    const handleViewDetails = async (actor: Actor) => {
        if (!window.openai?.callTool) return;

        await setWidgetState({
            ...widgetState,
            loadingDetails: actor.id,
            showDetails: true,
            requestedActorId: actor.id,
        });

        try {
            const response = await window.openai.callTool("fetch-actor-details", {
                actor: `${actor.username}/${actor.name}`,
            });

            if (response.structuredContent?.actorDetails) {
                setLocalActorDetails(response.structuredContent.actorDetails as ActorDetails);
            } else {
                console.warn("No actorDetails in response.structuredContent");
            }

            await setWidgetState({
                ...widgetState,
                loadingDetails: null,
                showDetails: true,
                requestedActorId: actor.id,
            });
        } catch (error) {
            console.error("Failed to fetch actor details:", error);
            await setWidgetState({
                ...widgetState,
                showDetails: false,
                loadingDetails: null,
                requestedActorId: null,
            });
        }
    };

    const handleBackToList = async () => {
        setLocalActorDetails(null);
        await setWidgetState({
            ...widgetState,
            showDetails: false,
            requestedActorId: null,
        });
    };

    return (
        <WidgetLayout>
            <div className="pb-6 w-full">
                {showDetails ? (
                    <ActorSearchDetail
                        details={actorDetails!}
                        onBackToList={handleBackToList}
                        showBackButton={!!widgetState?.requestedActorId && !hasToolActorDetails}
                    />
                ) : shouldShowDetailSkeleton ? (
                    <ActorSearchDetailSkeleton />
                ) : isInitialLoading ? (
                    <ActorSearchResultsSkeleton items={3} />
                ) : actors.length === 0 ? (
                    <EmptyState title="No actors found" description="Try a different search query" />
                ) : (
                    <Container>
                        <Header>
                            <Text type="body" size="regular" weight="medium">
                                search-actors
                            </Text>
                        </Header>
                        {actors.map((actor: Actor) => (
                            <ActorCardItem
                                key={actor.id}
                                actor={actor}
                                onViewDetails={() => handleViewDetails(actor)}
                            />
                        ))}
                    </Container>
                )}
            </div>
        </WidgetLayout>
    );
};

// ActorCardItem component
interface ActorCardItemProps {
    actor: Actor;
    onViewDetails: () => void;
}

const ActorCardItem: React.FC<ActorCardItemProps> = ({ actor, onViewDetails }) => {
    const title = actor.title || actor.name;
    const actorName = `${actor.username}/${actor.name}`;
    const rating = actor.stats?.actorReviewRating || 0;
    const ratingCount = actor.stats?.actorReviewCount || 0;
    const totalUsers = actor.stats?.totalUsers || 0;

    // Format numbers with k suffix
    const formatCount = (num: number): string => {
        if (num >= 1000) {
            return `${Math.floor(num / 1000)}k`;
        }
        return num.toString();
    };

    return (
        <ActorCardContainer onClick={onViewDetails} style={{ cursor: 'pointer' }}>
            <ActorHeader>
                <ActorIcon
                    src={actor.pictureUrl || '/default-actor-icon.png'}
                    alt={title}
                    onError={(e) => {
                        (e.target as HTMLImageElement).src = '/default-actor-icon.png';
                    }}
                />
                <ActorInfo>
                    <Text
                        type="body"
                        size="regular"
                        weight="medium"
                        style={{
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            width: '100%'
                        }}
                    >
                        {title}
                    </Text>
                    <Text
                        type="code"
                        size="small"
                        weight="medium"
                        color={theme.color.neutral.textSubtle}
                        style={{
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            width: '100%'
                        }}
                    >
                        {actorName}
                    </Text>
                </ActorInfo>
            </ActorHeader>

            <ContentSection>
                <Text type="body" size="small" weight="normal" color={theme.color.neutral.textMuted}>
                    {actor.description}
                </Text>

                <MetadataRow>
                    <DeveloperInfo>
                        <DeveloperLogo
                            src="https://apify.com/img/favicon.png"
                            alt="Apify"
                        />
                        <Text type="body" size="small" weight="medium" color={theme.color.neutral.textMuted}>
                            Apify
                        </Text>
                    </DeveloperInfo>

                    <StatsContainer>
                        <StatItem>
                            <StatIcon>
                                <StarEmptyIcon size="12" />
                            </StatIcon>
                            <Text type="body" size="small" weight="medium" color={theme.color.neutral.textMuted} as="span">
                                {rating.toFixed(1)}{' '}
                            </Text>
                            <Text type="body" size="small" weight="normal" color={theme.color.neutral.textSubtle} as="span">
                                ({formatCount(ratingCount)})
                            </Text>
                        </StatItem>

                        <Divider />

                        <StatItem>
                            <StatIcon>
                                <PeopleIcon size="12" />
                            </StatIcon>
                            <Text type="body" size="small" weight="medium" color={theme.color.neutral.textMuted} as="span">
                                {formatCount(totalUsers)}
                            </Text>
                        </StatItem>
                    </StatsContainer>
                </MetadataRow>
            </ContentSection>
        </ActorCardContainer>
    );
};

interface EmptyStateProps {
    title: string;
    description?: string;
}

const EmptyState: React.FC<EmptyStateProps> = (props: EmptyStateProps) => {
    const { title, description } = props;
    return (
        <Message type="info" caption={title}>
            {description ?? ""}
        </Message>
    );
};
