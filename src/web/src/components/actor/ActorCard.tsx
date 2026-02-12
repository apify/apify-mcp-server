import React from "react";
import styled from "styled-components";

import { Actor } from "../../types";
import { Text, Box, IconButton, ICON_BUTTON_VARIANTS, ActorAvatar, theme, clampLines } from "@apify/ui-library";
import { PeopleIcon, CoinIcon, StarEmptyIcon, ExternalLinkIcon } from "@apify/ui-icons";
import { formatNumber, formatDecimalNumber, formatPricing } from "../../utils/formatting";
import { ActorStats, StructuredPricingInfo } from "../../types";

interface ActorCardProps {
    actor: Actor;
    isDetail?: boolean;
}

const Container = styled(Box)<{ $withBorder: boolean }>`
    background: ${theme.color.neutral.background};
    display: flex;
    flex-direction: column;
    gap: ${theme.space.space8};
    border-radius: ${theme.radius.radius8};
    border: ${props => props.$withBorder ? `1px solid ${theme.color.neutral.separatorSubtle}` : 'none'};

    .clampToOneLine {
        ${clampLines(1)}
    }

    .flexShrink0 {
        flex-shrink: 0;
    }
`;

const BoxRow = styled(Box)`
    display: flex;
    gap: ${theme.space.space8};
    align-items: center;
    position: relative;
`;

const ActorHeaderWithActionButton = styled.div`
    display: flex;
    justify-content: space-between;
    align-items: center;
    width: 100%;
`;

const BoxGroup = styled(Box)`
    display: flex;
    gap: ${theme.space.space4};
    align-items: center;
`;

const StyledSeparator = styled(Box)`
    border-left: 1px solid ${theme.color.neutral.separatorSubtle};
    height: 8px;
    width: 1px;
`;

const DescriptionText = styled(Text)<{ isDetail: boolean }>`
    white-space: pre-wrap;
    ${({ isDetail }) => !isDetail && clampLines(2)};
`;

const ActorHeader = styled.div`
    display: flex;
    align-items: center;
    gap: ${theme.space.space8};
`;

const ActorTitleWrapper = styled.div`
    display: flex;
    flex-direction: column;
    gap: ${theme.space.space2};
`;

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
    stats?: ActorStats
    pricingInfo?: StructuredPricingInfo
    showFirstSeparator?: boolean;
}

const StatsContainer = styled(Box)`
    display: flex;
    flex-direction: row;
    flex-wrap: wrap;
    gap: ${theme.space.space8};
    align-items: center;
`;

const ShowOnMobile = styled(BoxRow)`
    display: flex;

    @media ${theme.device.tablet} {
        display: none;
    }
`;

const ShowOnTabletAndDesktop = styled(BoxRow)`
    display: none;

    @media ${theme.device.tablet} {
        display: flex;
    }
`;

const StatsRow: React.FC<StatsRowProps> = ({ stats, pricingInfo, showFirstSeparator = false }) => {
    const {totalUsers, actorReviewCount, actorReviewRating} = stats || {}
    const pricing = pricingInfo ? formatPricing(pricingInfo) : 'N/A';

    return (
        <StatsContainer>
            {totalUsers && <>
                {showFirstSeparator && <StyledSeparator />}
                <Stat
                    icon={<PeopleIcon size="12" color={theme.color.neutral.icon} />}
                    value={formatNumber(totalUsers)}
                />
            </>}
            {actorReviewCount && actorReviewRating && <>
                <StyledSeparator />
                <Stat
                    icon={<StarEmptyIcon size="12" color={theme.color.neutral.icon} />}
                    value={formatDecimalNumber(actorReviewRating)}
                    additionalInfo={`(${formatNumber(actorReviewCount)})`}
                />
            </>}
            {pricingInfo && <>
                <StyledSeparator />
                <Stat
                    icon={<CoinIcon size="12" color={theme.color.neutral.icon} />}
                    value={pricing}
                />
            </>}
        </StatsContainer>
    );
}

export const ActorCard: React.FC<ActorCardProps> = ({
    actor,
    isDetail = false,
}) => {
    const statsProps = {
        stats: actor.stats,
        pricingInfo: actor.currentPricingInfo,
        isDetail
    };

    return (
        <Container px="space16" py="space12" $withBorder={!isDetail}>
            <BoxRow>
                <ActorHeaderWithActionButton>
                    <ActorHeader>
                        <ActorAvatar size={40} name={actor.title} url={actor.pictureUrl} />
                        <ActorTitleWrapper>
                            <Text as="h3" weight="bold" color={theme.color.neutral.text} className="clampToOneLine" >{actor.title}</Text>
                            <BoxRow>
                                <Text
                                    size="small"
                                    weight="medium"
                                    type="code"
                                    color={theme.color.neutral.textSubtle}
                                    className="clampToOneLine"
                                >
                                    {actor.username}/{actor.name}
                                </Text>
                                {actor.stats && !isDetail && <ShowOnTabletAndDesktop><StatsRow {...statsProps} showFirstSeparator /></ShowOnTabletAndDesktop>}
                            </BoxRow>
                        </ActorTitleWrapper>
                    </ActorHeader>
                    {/* @ts-expect-error IconButton doesn't recognize `to` and `hideExternalIcon` props from Button */}
                    <IconButton Icon={ExternalLinkIcon} variant={ICON_BUTTON_VARIANTS.BORDERED} to={actor.url} hideExternalIcon className="flexShrink0" />
                </ActorHeaderWithActionButton>
            </BoxRow>

            <DescriptionText
                size="small"
                weight="normal"
                color={theme.color.neutral.text}
                isDetail={isDetail}
            >
                {actor.description}
            </DescriptionText>

            {actor.stats && isDetail && <StatsRow {...statsProps} />}
            {actor.stats && !isDetail && <ShowOnMobile><StatsRow {...statsProps} /></ShowOnMobile>}
        </Container>
    );
};
