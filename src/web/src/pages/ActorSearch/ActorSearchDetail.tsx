import React, { useMemo, useState } from "react";
import styled from "styled-components";
import { Badge, Text, Box, Markdown, StoreActorHeader, CodeBlock, IconButton, theme } from "@apify/ui-library";
import { ArrowLeftIcon, PeopleIcon, BookOpenIcon, InputIcon, CoinIcon, ApiIcon, StarEmptyIcon, ChevronDownIcon } from "@apify/ui-icons";
import { ActorDetails, ActorStats, PricingInfo } from "../../types";
import type { IconComponent } from "@apify/ui-icons";
import { formatNumber, formatDecimalNumber, getPricingInfo } from "../../utils/formatting";

type ActorSearchDetailProps = {
    details: ActorDetails;
    onBackToList: () => void;
    showBackButton?: boolean;
    pricingInfo?: PricingInfo;
}

const Container = styled(Box)`
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
`;

const HeaderSection = styled(Box)`
    background: ${theme.color.neutral.background};
    display: flex;
    flex-direction: column;
    gap: ${theme.space.space8};
`;

const BoxRow = styled(Box)<{ $gap: string }>`
    display: flex;
    gap: ${props => props.$gap};
    align-items: center;
`;

const ExpandableSectionWrapper = styled(Box)`
    background: ${theme.color.neutral.background};
    display: flex;
    align-items: center;
    justify-content: space-between;
    cursor: pointer;
    transition: background-color ${theme.transition.fastEaseOut};
    border-top: 1px solid ${theme.color.neutral.separatorSubtle};

    &:hover {
        background: ${theme.color.neutral.backgroundSubtle};
    }

    &:last-child {
        border-bottom-left-radius: ${theme.radius.radius8};
        border-bottom-right-radius: ${theme.radius.radius8};
    }
`;

const ChevronIconWrapper = styled.div<{ $expanded: boolean }>`
    display: flex;
    align-items: center;
    transition: transform ${theme.transition.fastEaseOut};
    transform: ${props => props.$expanded ? 'rotate(180deg)' : 'rotate(0deg)'};
`;

const SectionContent = styled(Box)<{ $expanded: boolean }>`
    background: ${theme.color.neutral.background};
    max-height: ${props => props.$expanded ? 'unset' : '0'};
    overflow: hidden;
    color: ${theme.color.neutral.text};
`;

const PreWrapText = styled.span`
    white-space: pre-wrap;
`;

const StyledSeparator = styled(Box)`
    border-left: 1px solid ${theme.color.neutral.separatorSubtle};
    height: 8px;
    width: 1px;
`;

type ExpandableSectionProps = {
    title: string;
    icon: IconComponent;
    expanded: boolean;
    onToggle: () => void;
    children: React.ReactNode;
}

const ExpandableSection: React.FC<ExpandableSectionProps> = ({
    title,
    icon,
    expanded,
    onToggle,
    children
}) => (
    <>
        <ExpandableSectionWrapper onClick={onToggle} px="space16" py="space12">
            <Badge size="regular" variant="neutral" LeadingIcon={icon}>
                {title}
            </Badge>
            <BoxRow $gap={theme.space.space4}>
                <Text
                    size="small"
                    weight="medium"
                    color={theme.color.neutral.text}
                >
                    {expanded ? "Hide" : "View all"}
                </Text>
                <ChevronIconWrapper $expanded={expanded}>
                    <ChevronDownIcon size="20" color={theme.color.neutral.icon} />
                </ChevronIconWrapper>
            </BoxRow>
        </ExpandableSectionWrapper>
        <SectionContent $expanded={expanded}>
            <Box p="space16">
                {children}
            </Box>
        </SectionContent>
    </>
);

type ReadmeSectionProps = {
    readme: string | null;
    expanded: boolean;
    onToggle: () => void;
}

const ReadmeSection: React.FC<ReadmeSectionProps> = ({ readme, expanded, onToggle }) => {
    if (!readme) return null

    return (
        <ExpandableSection
            title="Readme"
            icon={BookOpenIcon}
            expanded={expanded}
            onToggle={onToggle}
        >
            <Markdown markdown={readme} />
        </ExpandableSection>
    );
};

type InputSectionProps = {
    inputSchema: any;
    expanded: boolean;
    onToggle: () => void;
}

const InputSection: React.FC<InputSectionProps> = ({ inputSchema, expanded, onToggle }) => {

    return (
        <ExpandableSection
            title="Input"
            icon={InputIcon}
            expanded={expanded}
            onToggle={onToggle}
        >
            {/* <JsonSchemaViewer definition={inputSchema} /> */}
            <CodeBlock content={JSON.stringify(inputSchema, null, 4)}
                language="json"
                fullWidth
                fullHeight
            />
        </ExpandableSection>
    );
};

type PricingSectionProps = {
    pricingInfo: any;
    expanded: boolean;
    onToggle: () => void;
}

const PricingSection: React.FC<PricingSectionProps> = ({ pricingInfo, expanded, onToggle }) => {
    const pricingText = useMemo(() => {
        return getPricingInfo(
            pricingInfo || {
                pricingModel: "FREE",
                pricePerResultUsd: 0,
                monthlyChargeUsd: 0,
            }
        );
    }, [pricingInfo]);

    return (
        <ExpandableSection
            title="Pricing"
            icon={CoinIcon}
            expanded={expanded}
            onToggle={onToggle}
        >
            <Text color={theme.color.neutral.text}>{pricingText.value}</Text>
            {pricingText.additionalInfo && (
                <Text size="small" color={theme.color.neutral.textSubtle} as="span"> {pricingText.additionalInfo}</Text>
            )}
        </ExpandableSection>
    );
};

type ApiSectionProps = {
    actorCard: string | null;
    expanded: boolean;
    onToggle: () => void;
}

const ApiSection: React.FC<ApiSectionProps> = ({ actorCard, expanded, onToggle }) => {
    if (!actorCard) return null;

    return (
        <ExpandableSection
            title="API"
            icon={ApiIcon}
            expanded={expanded}
            onToggle={onToggle}
        >
            <pre>{actorCard}</pre>
        </ExpandableSection>
    );
};

type ReviewsSectionProps = {
    stats: ActorStats | undefined;
    expanded: boolean;
    onToggle: () => void;
}

const ReviewsSection: React.FC<ReviewsSectionProps> = ({ stats, expanded, onToggle }) => {
    const rating = stats?.actorReviewRating || 0;
    const reviewCount = stats?.actorReviewCount || 0;

    return (
        <ExpandableSection
            title="Reviews"
            icon={StarEmptyIcon}
            expanded={expanded}
            onToggle={onToggle}
        >
            <BoxRow $gap={theme.space.space4}>
                <Text size="regular" color={theme.color.neutral.text}>
                    {formatDecimalNumber(rating)} ⭐
                </Text>
                <Text size="regular" color={theme.color.neutral.textMuted}>
                    ({formatNumber(reviewCount)} {reviewCount === 1 ? 'review' : 'reviews'})
                </Text>
            </BoxRow>
            {reviewCount === 0 && (
                <Text size="small" color={theme.color.neutral.textSubtle} style={{ marginTop: '8px' }}>
                    No reviews yet. Be the first to review this actor!
                </Text>
            )}
        </ExpandableSection>
    );
};

type StatProps = {
    icon: React.JSX.Element
    value: string
    additionalInfo?: string
}

const Stat: React.FC<StatProps> = ({ icon, value, additionalInfo }) => {
    return (
        <BoxRow $gap={theme.space.space4}>
            {icon}
            <Text
                size="small"
                weight="medium"
                color={theme.color.neutral.textMuted}
            >
                {value}
                {additionalInfo && <Text size="small" color={theme.color.neutral.textSubtle} as="span"> {additionalInfo}</Text>}
            </Text>
        </BoxRow>
    )
}

type StatsRowProps = {
    stats: ActorStats
    pricingInfo?: PricingInfo
}

const StatsRow: React.FC<StatsRowProps> = ({ stats, pricingInfo }) => {
    const {totalUsers, actorReviewCount, actorReviewRating} = stats || {}
    const {value: pricingValue, additionalInfo: pricingAdditionalInfo} = getPricingInfo(pricingInfo || {pricingModel: "FREE", monthlyChargeUsd: 0, pricePerResultUsd: 0});

    return (
        <BoxRow py="space4" $gap={theme.space.space8}>
            <Stat
                icon={<PeopleIcon size="12" color={theme.color.neutral.icon} />}
                value={formatNumber(totalUsers)}
            />
            <StyledSeparator />
            <Stat
                icon={<StarEmptyIcon size="12" color={theme.color.neutral.icon} />}
                value={formatDecimalNumber(actorReviewRating)}
                additionalInfo={`(${formatNumber(actorReviewCount)})`}
            />
            {pricingInfo && <>
                <StyledSeparator />
                <Stat
                    icon={<CoinIcon size="12" color={theme.color.neutral.icon} />}
                    value={pricingValue}
                    additionalInfo={pricingAdditionalInfo}
                />
            </>}
        </BoxRow>
    )
}

export const ActorSearchDetail: React.FC<ActorSearchDetailProps> = ({ details, pricingInfo, onBackToList, showBackButton = true }) => {
    const actor = details.actorInfo;
    const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});

    const toggleSection = (sectionName: string) => {
        setExpandedSections(prev => ({
            ...prev,
            [sectionName]: !prev[sectionName]
        }));
    };

    return (
        <Container>
            <CardWrapper>
                <HeaderSection px="space16" py="space12">
                    <BoxRow $gap={theme.space.space8}>
                        {showBackButton && <IconButton Icon={ArrowLeftIcon} onClick={onBackToList} />}
                        <StoreActorHeader
                            name={actor.name}
                            title={actor.title}
                            pictureUrl={actor.pictureUrl}
                            username={actor.username}
                        />
                    </BoxRow>

                    <Text
                        size="regular"
                        weight="normal"
                        color={theme.color.neutral.text}
                        as={PreWrapText}
                    >
                        {actor.description}
                    </Text>

                    {actor.stats && <StatsRow stats={actor.stats} pricingInfo={pricingInfo} />}
                </HeaderSection>

                <ReadmeSection
                    readme={details.readme}
                    expanded={expandedSections['readme'] || false}
                    onToggle={() => toggleSection('readme')}
                />

                <InputSection
                    inputSchema={details.inputSchema}
                    expanded={expandedSections['input'] || false}
                    onToggle={() => toggleSection('input')}
                />

                <PricingSection
                    pricingInfo={pricingInfo}
                    expanded={expandedSections['pricing'] || false}
                    onToggle={() => toggleSection('pricing')}
                />

                <ApiSection
                    actorCard={details.actorCard}
                    expanded={expandedSections['api'] || false}
                    onToggle={() => toggleSection('api')}
                />

                <ReviewsSection
                    stats={actor.stats}
                    expanded={expandedSections['reviews'] || false}
                    onToggle={() => toggleSection('reviews')}
                />
            </CardWrapper>
        </Container>
    );
};
