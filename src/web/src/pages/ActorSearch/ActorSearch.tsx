import React from "react";
import { useWidgetProps } from "../../hooks/use-widget-props";
import { ActorSearchDetail } from "./ActorSearchDetail";
import { WidgetLayout } from "../../components/layout/WidgetLayout";
import { Message, Box } from "@apify/ui-library";
import { ActorDetails, Actor } from "../../types";
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

export const ActorSearch: React.FC = () => {
    const toolOutput = useWidgetProps<ToolOutput>();

    // Prefer widget format actors if available (for widget mode), otherwise use schema-compliant format
    const hasToolActorDetails = Boolean(toolOutput?.actorDetails);
    const actorsFromTool = (toolOutput as any)?.widgetActors || toolOutput?.actors;
    const actorDetails = toolOutput?.actorDetails;

    // When actorDetails is provided directly from tool (details-only call), ignore actors to force details view
    // This handles the case when fetch-actor-details is called directly (not from search)
    const actors = hasToolActorDetails ? [] : actorsFromTool || [];

    const shouldForceDetailsView = hasToolActorDetails;

    const showDetails = (shouldForceDetailsView) && Boolean(actorDetails);
    const hasLoadedOnce = Boolean(toolOutput && ("actors" in toolOutput || "actorDetails" in toolOutput));

    const isInitialLoading = !hasLoadedOnce && !actorDetails;
    const shouldShowDetailSkeleton = shouldForceDetailsView && !actorDetails;

    return (
        <WidgetLayout>
            <ActorSearchResults>
            {showDetails ? (
                <ActorSearchDetail details={actorDetails!} />
            ) : shouldShowDetailSkeleton ? (
                <ActorSearchDetailSkeleton />
            ) : isInitialLoading ? (
                <ActorSearchResultsSkeleton items={3} />
            ) : actors.length === 0 ? (
                <EmptyState title="No actors found" description="Try a different search query" />
            ) : (
                actors.map((actor: Actor) => (
                    <ActorContainer key={actor.id} mb="space12">
                        <ActorCard actor={actor} />
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
