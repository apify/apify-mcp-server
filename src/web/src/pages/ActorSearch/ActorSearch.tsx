import React, { useState, useEffect } from "react";
import { useWidgetProps } from "../../hooks/use-widget-props";
import { useWidgetState } from "../../hooks/use-widget-state";
import { ActorSearchDetail } from "./ActorSearchDetail";
import { WidgetLayout } from "../../components/layout/WidgetLayout";
import { Message, Box } from "@apify/ui-library";
import { ActorDetails, Actor, PricingInfo } from "../../types";
import { ActorCard } from "../../components/actor/ActorCard";
import { ActorSearchDetailSkeleton, ActorSearchResultsSkeleton } from "./ActorSearch.skeleton";
import styled from "styled-components";

const ActorContainer = styled(Box)`
    width: 100%;
    &:first-child {
        margin-top: 0;
    }
    &:last-child {
        margin-bottom: 0;
    }
`;

const ActorSearchResults = styled(Box)`
    display: flex;
    flex-direction: column;
    width: 100%;
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
    const [selectedPricingInfo, setSelectedPricingInfo] = useState<PricingInfo | undefined>(undefined);

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

        await window.openai?.requestDisplayMode({ mode: "fullscreen" });

        setSelectedPricingInfo(actor.currentPricingInfo || undefined);

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
        await window.openai?.requestDisplayMode({ mode: "inline" });
        setLocalActorDetails(null);
        await setWidgetState({
            ...widgetState,
            showDetails: false,
            requestedActorId: null,
        });
    };

    return (
        <WidgetLayout>
            <ActorSearchResults>
            {showDetails ? (
                <ActorSearchDetail
                    details={actorDetails!}
                    pricingInfo={selectedPricingInfo}
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
                actors.map((actor: Actor) => (
                    <ActorContainer key={actor.id} mb="space12">
                        <ActorCard
                            actor={actor}
                            onViewDetails={() => handleViewDetails(actor)}
                            // isLoading={true}
                        />
                    </ActorContainer>
                ))
            )}
            </ActorSearchResults>
        </WidgetLayout>
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
