import React, { useMemo, useState } from "react";
import styled from "styled-components";
import { Badge, IconButton, Text, Box, Markdown, theme } from "@apify/ui-library";
import { ArrowLeftIcon, PeopleIcon, BookOpenIcon, InputIcon, CoinIcon, ApiIcon, ChevronDownIcon } from "@apify/ui-icons";
import { formatPricing } from "../../utils/formatting";
import { ActorDetails } from "../../types";
import type { IconComponent } from "@apify/ui-icons";

type ActorSearchDetailProps = {
    details: ActorDetails;
    onBackToList: () => void;
    showBackButton?: boolean;
}

type InputSchema = {
    properties?: Record<
        string,
        {
            type?: string;
            description?: string;
            [key: string]: any;
        }
    >;
};

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

const HeaderTop = styled(Box)`
    display: flex;
    gap: ${theme.space.space12};
    align-items: center;
`;

const ActorLogo = styled.img`
    width: 40px;
    height: 40px;
    border-radius: ${theme.radius.radius8};
    border: 1px solid ${theme.color.neutral.separatorSubtle};
    object-fit: cover;
`;

const TitleGroup = styled(Box)`
    display: flex;
    flex-direction: column;
    gap: ${theme.space.space2};
    flex: 1;
    min-width: 0;
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

const PublisherLogo = styled.div<{ $hasImage: boolean }>`
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: ${props => props.$hasImage ? 'transparent' : theme.color.neutral.backgroundSubtle};
    border: 1px solid ${theme.color.neutral.separatorSubtle};
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    flex-shrink: 0;
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
    const inputProps = useMemo(() => {
        const schema = inputSchema as unknown as InputSchema | undefined;
        const props = schema?.properties ?? {};
        return Object.entries(props);
    }, [inputSchema]);

    if (inputProps.length === 0) return null;

    return (
        <ExpandableSection
            title="Input"
            icon={InputIcon}
            expanded={expanded}
            onToggle={onToggle}
        >
            <pre>{JSON.stringify(inputSchema, null, 2)}</pre>
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

export const ActorSearchDetail: React.FC<ActorSearchDetailProps> = ({ details, onBackToList, showBackButton = true }) => {
    const actor = details.actorInfo;
    const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});

    const toggleSection = (sectionName: string) => {
        setExpandedSections(prev => ({
            ...prev,
            [sectionName]: !prev[sectionName]
        }));
    };

    const usageCount = actor.stats?.totalUsers ? formatNumber(actor.stats.totalUsers) : null;

    return (
        <Container>
            <CardWrapper>
                <HeaderSection px="space16" py="space12">
                    <Box style={{ display: "flex", gap: theme.space.space16, flexDirection: 'column' }}>
                        <HeaderTop>
                            {showBackButton && (
                                <IconButton
                                    Icon={ArrowLeftIcon}
                                    onClick={onBackToList}
                                    size="small"
                                    title="Back to search results"
                                />
                            )}
                            <ActorLogo
                                src={actor.pictureUrl}
                                alt={actor.title || actor.name}
                            />
                            <TitleGroup>
                                <Text
                                    weight="medium"
                                    color={theme.color.neutral.text}
                                    style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                >
                                    {actor.title || actor.name}
                                </Text>
                                <Text
                                    type="code"
                                    size="small"
                                    weight="medium"
                                    color={theme.color.neutral.textSubtle}
                                    style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                >
                                    {`${actor.username}/${actor.name}`}
                                </Text>
                            </TitleGroup>
                        </HeaderTop>

                        <Text
                            size="regular"
                            weight="normal"
                            color={theme.color.neutral.text}
                            style={{ whiteSpace: 'pre-wrap' }}
                        >
                            {actor.description}
                        </Text>
                    </Box>

                    {usageCount && (
                        <BoxRow py="space4">
                            <BoxGroup>
                                <PublisherLogo $hasImage={false}>
                                    {/* Empty circle placeholder - publisher logo would go here */}
                                </PublisherLogo>
                                <Text
                                    size="small"
                                    weight="medium"
                                    color={theme.color.neutral.textMuted}
                                >
                                    Apify
                                </Text>
                            </BoxGroup>

                            <BoxGroup>
                                <PeopleIcon size="12" color={theme.color.neutral.icon} />
                                <Text
                                    size="small"
                                    weight="medium"
                                    color={theme.color.neutral.textMuted}
                                >
                                    {usageCount}
                                </Text>
                            </BoxGroup>
                        </BoxRow>
                    )}
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
