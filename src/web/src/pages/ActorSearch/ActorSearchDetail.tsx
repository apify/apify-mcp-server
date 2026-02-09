import React, { useMemo, useState } from "react";
import styled from "styled-components";
import { Badge, Text, Box, Markdown, CodeBlock, theme, useActorTitleHeadingFilter } from "@apify/ui-library";
import { BookOpenIcon, InputIcon, CoinIcon, ApiIcon, StarEmptyIcon, ChevronDownIcon } from "@apify/ui-icons";
import { ActorDetails, PricingInfo, Rating } from "../../types";
import type { IconComponent } from "@apify/ui-icons";
import { formatNumber, formatDecimalNumber, getPricingInfo } from "../../utils/formatting";
import { ActorCard } from "../../components/actor/ActorCard";

type ActorSearchDetailProps = {
    details: ActorDetails;
    onBackToList: () => void;
    showBackButton?: boolean;
    pricingInfo?: PricingInfo;
}

const README_CLASSNAMES = {
    MARKDOWN_WRAPPER: 'Readme-MarkdownWrapper',
    MARKDOWN: 'Readme-Markdown',
    ONELINE_SCROLLABLE_WRAPPER: 'OneLineCode-ScrollableWrapper',
};

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
    min-width: 400px;
    width: 100%;
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

const ReadmeWrapper = styled.div`
    display: grid;
    grid-template-columns: 85% 15%;
    grid-template-rows: auto;
    grid-template-areas: 'readme readme';

    .${README_CLASSNAMES.MARKDOWN_WRAPPER} {
        grid-area: readme;
    }
    /* TODO: this is an exception from the design system, let's figure out how to not do overrides */
    .${README_CLASSNAMES.MARKDOWN} {
        p,
        li,
        strong,
        b,
        table,
        code {
            font-size: 1.2rem;
        }

        ul {
            display: block;
            list-style-type: disc;
            margin-block-start: 1em;
            margin-block-end: 1em;
            padding-inline-start: 40px;
            unicode-bidi: isolate;
        }

        div:not(.${README_CLASSNAMES.ONELINE_SCROLLABLE_WRAPPER}) > pre {
            display: block;
            padding-left: 1.6rem;
            padding-right: 1.6rem;
        }
    }
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

    const allowElement = useActorTitleHeadingFilter("Readme");

    return (
        <ExpandableSection
            title="Readme"
            icon={BookOpenIcon}
            expanded={expanded}
            onToggle={onToggle}
        >
            <ReadmeWrapper>
                <div className={README_CLASSNAMES.MARKDOWN_WRAPPER}>
                    <Markdown markdown={readme} className={README_CLASSNAMES.MARKDOWN} allowElement={allowElement} lazyLoadImages/>
                </div>
            </ReadmeWrapper>
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
    rating: Rating | undefined;
    expanded: boolean;
    onToggle: () => void;
}

const ReviewsSection: React.FC<ReviewsSectionProps> = ({ rating, expanded, onToggle }) => {
    const averageRating = rating?.average || 0;
    const reviewCount = rating?.count || 0;

    return (
        <ExpandableSection
            title="Reviews"
            icon={StarEmptyIcon}
            expanded={expanded}
            onToggle={onToggle}
        >
            <BoxRow $gap={theme.space.space4}>
                <Text size="regular" color={theme.color.neutral.text}>
                    {formatDecimalNumber(averageRating)} ⭐
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
                <ActorCard
                    actor={actor}
                    showViewDetailsButton={false}
                    pricingInfo={pricingInfo}
                    showBackButton={showBackButton}
                    onBackClick={onBackToList}
                    isDetail
                />

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
                    rating={actor.rating}
                    expanded={expandedSections['reviews'] || false}
                    onToggle={() => toggleSection('reviews')}
                />
            </CardWrapper>
        </Container>
    );
};
