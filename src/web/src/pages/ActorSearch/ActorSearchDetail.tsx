import React, { useMemo, useState } from "react";
import styled from "styled-components";
import { Badge, Text, Box, Markdown, StoreActorHeader, CodeBlock, theme } from "@apify/ui-library";
import { PeopleIcon, BookOpenIcon, InputIcon, CoinIcon, ApiIcon, ChevronDownIcon, StarEmptyIcon } from "@apify/ui-icons";
import { formatPricing } from "../../utils/formatting";
import { ActorDetails, ActorStats, PricingInfo } from "../../types";
import type { IconComponent } from "@apify/ui-icons";

type ActorSearchDetailProps = {
    details: ActorDetails;
    onBackToList: () => void;
    showBackButton?: boolean;
}

const Container = styled(Box)`
    display: flex;
    flex-direction: column;
    width: 100%;
`;

const CardWrapper = styled(Box)`
    background: ${theme.color.neutral.backgroundSubtle};
    border-radius: ${theme.radius.radius8};
    display: flex;
    flex-direction: column;
    gap: ${theme.space.space2};
    overflow: hidden;
`;

const HeaderSection = styled(Box)`
    background: ${theme.color.neutral.background};
    display: flex;
    flex-direction: column;
    gap: ${theme.space.space8};
    border-top-left-radius: ${theme.radius.radius8};
    border-top-right-radius: ${theme.radius.radius8};
`;

const BoxRow = styled(Box)`
    display: flex;
    gap: ${theme.space.space8};
    align-items: center;
`;

const BoxGroup = styled(Box)`
    display: flex;
    gap: ${theme.space.space4};
    align-items: center;
`;

const SectionWrapper = styled(Box)`
    &:first-of-type {
        border-top-left-radius: 0;
        border-top-right-radius: 0;
    }

    &:last-child {
        border-bottom-left-radius: ${theme.radius.radius8};
        border-bottom-right-radius: ${theme.radius.radius8};
    }
`;

const ExpandableSectionWrapper = styled(Box)`
    background: ${theme.color.neutral.background};
    display: flex;
    align-items: center;
    justify-content: space-between;
    cursor: pointer;
    transition: background-color ${theme.transition.fastEaseOut};

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
    <SectionWrapper>
        <ExpandableSectionWrapper onClick={onToggle} px="space16" py="space12">
            <Badge size="regular" variant="neutral" LeadingIcon={icon}>
                {title}
            </Badge>
            <BoxGroup>
                <Text
                    size="small"
                    weight="medium"
                    color={theme.color.neutral.text}
                >
                    View all
                </Text>
                <ChevronIconWrapper $expanded={expanded}>
                    <ChevronDownIcon size="20" color={theme.color.neutral.icon} />
                </ChevronIconWrapper>
            </BoxGroup>
        </ExpandableSectionWrapper>
        <SectionContent $expanded={expanded}>
            <Box p="space16">
                {children}
            </Box>
        </SectionContent>
    </SectionWrapper>
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
        return formatPricing(
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
            <Text color={theme.color.neutral.text}>{pricingText}</Text>
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

type StatProps = {
    icon: React.JSX.Element
    value: string
    additionalInfo?: string
}

const Stat: React.FC<StatProps> = ({ icon, value, additionalInfo }) => {
    return (
        <BoxGroup>
            {icon}
            <Text
                size="small"
                weight="medium"
                color={theme.color.neutral.textMuted}
            >
                {value}
                {additionalInfo && <Text size="small" color={theme.color.neutral.textSubtle} as="span"> {additionalInfo}</Text>}
            </Text>
        </BoxGroup>
    )
}

type StatsRowProps = {
    stats: ActorStats
    pricingInfo?: PricingInfo
}

const StatsRow: React.FC<StatsRowProps> = ({ stats, pricingInfo }) => {
    const {totalUsers, actorReviewCount, actorReviewRating} = stats || {}
    console.log(pricingInfo)
    const {pricePerResultUsd} = pricingInfo || {};

    return (
        <BoxRow py="space4">
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
            {pricePerResultUsd && <>
                <StyledSeparator />
                <Stat
                    icon={<CoinIcon size="12" color={theme.color.neutral.icon} />}
                    value={`$${formatDecimalNumber(pricePerResultUsd)}`}
                    additionalInfo="per result"
                />
            </>}
        </BoxRow>
    )
}

export const ActorSearchDetail: React.FC<ActorSearchDetailProps> = ({ details, onBackToList, showBackButton = true }) => {
    const actor = details.actorInfo;
    const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});

    const toggleSection = (sectionName: string) => {
        setExpandedSections(prev => ({
            ...prev,
            [sectionName]: !prev[sectionName]
        }));
    };
    console.log(actor)

    return (
        <Container>
            {/* <CodeBlock content={JSON.stringify(details, null, 4)}
                language="json"
                fullWidth
                fullHeight
            /> */}
            <CardWrapper>
                <HeaderSection px="space16" py="space12">
                    <StoreActorHeader
                        name={actor.name}
                        title={actor.title}
                        pictureUrl={actor.pictureUrl}
                        username={actor.username}
                    />

                    <Text
                        size="regular"
                        weight="normal"
                        color={theme.color.neutral.text}
                        as={PreWrapText}
                    >
                        {actor.description}
                    </Text>

                    {actor.stats && <StatsRow stats={actor.stats} pricingInfo={actor.pricingInfos ? actor.pricingInfos[0] : undefined} />}
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
                    pricingInfo={actor.currentPricingInfo}
                    expanded={expandedSections['pricing'] || false}
                    onToggle={() => toggleSection('pricing')}
                />

                <ApiSection
                    actorCard={details.actorCard}
                    expanded={expandedSections['api'] || false}
                    onToggle={() => toggleSection('api')}
                />
            </CardWrapper>
        </Container>
    );
};

function formatNumber(num: number): string {
    if (num >= 1000000) {
        return (num / 1000000).toFixed(1) + 'M';
    }
    if (num >= 1000) {
        return (num / 1000).toFixed(0) + 'k';
    }

    return num.toString();
}

function formatDecimalNumber(value: number): string {
    if (Number.isInteger(value)) {
        return value.toString();
    }
    return value.toFixed(1);
}
