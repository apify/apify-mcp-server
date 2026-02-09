import React from "react";
import styled from "styled-components";
import { SkeletonBlock } from "../../components/ui/SkeletonBlock";
import { Box, theme } from "@apify/ui-library";

const Container = styled(Box)`
    background: ${theme.color.neutral.background};
    display: flex;
    flex-direction: column;
    gap: ${theme.space.space8};
    border-radius: ${theme.radius.radius8};
    border: 1px solid ${theme.color.neutral.separatorSubtle};
`;

const BoxRow = styled(Box)`
    display: flex;
    gap: ${theme.space.space8};
    position: relative;
`;

const ContentColumn = styled(Box)`
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: ${theme.space.space6};
    min-width: 0;
    justify-content: center;
`;

const DescriptionGroup = styled(Box)`
    display: flex;
    flex-direction: column;
    gap: ${theme.space.space4};
    width: 100%;
`;

const AlignEnd = styled.div`
    margin-left: auto;
    align-self: flex-start;
    position: absolute;
    right: 0;
    top: 0;
`;

interface ActorListItemSkeletonProps {
    isFirst?: boolean;
    isLast?: boolean;
}

const ActorListItemSkeleton: React.FC<ActorListItemSkeletonProps> = () => {
    return (
        <Container px="space16" py="space12">
            <BoxRow>
                {/* Actor logo placeholder - matches StoreActorHeader size */}
                <SkeletonBlock style={{ width: '40px', height: '40px', borderRadius: theme.radius.radius8, flexShrink: 0 }} />

                <ContentColumn>
                    {/* Title placeholder */}
                    <SkeletonBlock style={{ height: '20px', width: '66%' }} />

                    {/* Stats row placeholder - matches stats row height */}
                    <SkeletonBlock style={{ height: '16px', width: '80%' }} />

                </ContentColumn>

                {/* Icon button placeholder */}
                <AlignEnd>
                    <SkeletonBlock style={{ width: '32px', height: '32px', borderRadius: theme.radius.radius8, flexShrink: 0 }} />
                </AlignEnd>
            </BoxRow>

                            {/* Description (2 lines) - matches Text size="small" */}
                <DescriptionGroup>
                    <SkeletonBlock style={{ height: '14px', width: '100%' }} />
                    <SkeletonBlock style={{ height: '14px', width: '100%' }} />
                </DescriptionGroup>
        </Container>
    );
};

const ResultsContainer = styled(Box)`
    display: flex;
    flex-direction: column;
    gap: ${theme.space.space12};
    width: 100%;
`;

export const ActorSearchResultsSkeleton: React.FC<{ items?: number }> = ({ items = 3 }) => {
    return (
        <ResultsContainer>
            {Array.from({ length: items }).map((_, i) => (
                <ActorListItemSkeleton key={i} isFirst={i === 0} isLast={i === items - 1} />
            ))}
        </ResultsContainer>
    );
};

const DetailContainer = styled(Box)`
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    width: 100%;
`;

const CardWrapper = styled(Box)`
    background: ${theme.color.neutral.background};
    border-radius: ${theme.radius.radius8};
    border: 1px solid ${theme.color.neutral.separatorSubtle};
    display: flex;
    flex-direction: column;
    overflow: hidden;
    max-width: 796px;
    width: 100%;
`;

const HeaderSection = styled(Box)`
    background: ${theme.color.neutral.background};
    display: flex;
    flex-direction: column;
    gap: ${theme.space.space8};
`;

const HeaderRow = styled(Box)`
    display: flex;
    gap: ${theme.space.space8};
    align-items: center;
`;

const HeaderColumn = styled(Box)`
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: ${theme.space.space8};
    min-width: 0;
`;

const DescriptionLines = styled(Box)`
    display: flex;
    flex-direction: column;
    gap: ${theme.space.space8};
`;

const SectionsGroup = styled(Box)`
    display: flex;
    flex-direction: column;
`;

export const ActorSearchDetailSkeleton: React.FC = () => {
    return (
        <DetailContainer>
            <CardWrapper>
                <HeaderSection px="space16" py="space12">
                    <HeaderRow py="space2">
                        {/* Actor icon - matches StoreActorHeader size */}
                        <SkeletonBlock style={{ width: '64px', height: '64px', borderRadius: theme.radius.radius8, flexShrink: 0 }} />
                        <HeaderColumn>
                            {/* Title placeholder */}
                            <SkeletonBlock style={{ height: '20px', width: '50%' }} />
                            {/* Username placeholder */}
                            <SkeletonBlock style={{ height: '16px', width: '33%' }} />
                        </HeaderColumn>
                    </HeaderRow>

                    {/* Description */}
                    <DescriptionLines>
                        <SkeletonBlock style={{ height: '16px', width: '100%' }} />
                        <SkeletonBlock style={{ height: '16px', width: '80%' }} />
                    </DescriptionLines>

                    {/* Stats row */}
                    <SkeletonBlock style={{ height: '16px', width: '66%' }} />
                </HeaderSection>

                {/* Expandable Sections */}
                <SectionsGroup>
                    <SectionHeaderSkeleton />
                    <SectionHeaderSkeleton />
                    <SectionHeaderSkeleton />
                    <SectionHeaderSkeleton />
                    <SectionHeaderSkeleton />
                </SectionsGroup>
            </CardWrapper>
        </DetailContainer>
    );
};

const SectionHeaderWrapper = styled(Box)`
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: ${theme.color.neutral.background};
    border-top: 1px solid ${theme.color.neutral.separatorSubtle};
`;

const SectionHeaderSkeleton: React.FC = () => {
    return (
        <SectionHeaderWrapper px="space16" py="space12">
            <SkeletonBlock style={{ height: '24px', width: '96px' }} />
            <SkeletonBlock style={{ height: '16px', width: '64px' }} />
        </SectionHeaderWrapper>
    );
};

