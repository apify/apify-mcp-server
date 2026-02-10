import React from "react";
import styled from "styled-components";

import { Actor } from "../../types";
import { Text, Box, IconButton, ICON_BUTTON_VARIANTS, ActorAvatar, theme, clampLines } from "@apify/ui-library";
import { PeopleIcon, CoinIcon, StarEmptyIcon, ExternalLinkIcon } from "@apify/ui-icons";
import { formatNumber, getPricingInfo, formatDecimalNumber } from "../../utils/formatting";
import { ActorStats, PricingInfo } from "../../types";

interface ActorCardProps {
    actor: Actor;
    isDetail?: boolean;
}

const makeActorRedirectUrl = (username: string, actorName: string) => {
    return `https://apify.com/${username}/${actorName}`;
};

const Container = styled(Box)<{ $withBorder: boolean }>`
    background: ${theme.color.neutral.background};
    display: flex;
    flex-direction: column;
    gap: ${theme.space.space8};
    border-radius: ${theme.radius.radius8};
    border: ${props => props.$withBorder ? `1px solid ${theme.color.neutral.separatorSubtle}` : 'none'};
`;

const BoxRow = styled(Box)`
    display: flex;
    gap: ${theme.space.space8};
    align-items: center;
    position: relative;
`;

const AlignBottom = styled.div`
    align-self: flex-end;
    margin-left: ${theme.space.space2};
`;

const AlignEnd = styled.div`
    margin-left: auto;
    align-self: flex-start;
    position: absolute;
    right: 0;
    top: 0;
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
    pricingInfo?: PricingInfo
    rating?: {
        average: number;
        count: number;
    }
    isDetail: boolean;
}

const StatsRow: React.FC<StatsRowProps> = ({ stats, pricingInfo, rating, isDetail }) => {
    const {totalUsers} = stats || {}
    const {value: pricingValue, additionalInfo: pricingAdditionalInfo} = getPricingInfo(pricingInfo || {pricingModel: "FREE", monthlyChargeUsd: 0, pricePerResultUsd: 0});

    return (
        <BoxRow>
            {totalUsers && <>
                {!isDetail && <StyledSeparator />}
                <Stat
                    icon={<PeopleIcon size="12" color={theme.color.neutral.icon} />}
                    value={formatNumber(totalUsers)}
                />
            </>}
            {rating && <>
                <StyledSeparator />
                <Stat
                    icon={<StarEmptyIcon size="12" color={theme.color.neutral.icon} />}
                    value={formatDecimalNumber(rating.average)}
                    additionalInfo={`(${formatNumber(rating.count)})`}
                />
            </>}
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

export const ActorCard: React.FC<ActorCardProps> = ({
    actor,
    isDetail = false,
}) => {
    const statsProps = {
        stats: actor.stats,
        pricingInfo: actor.currentPricingInfo,
        rating: actor.rating,
        isDetail
    };

    const actorRedirectUrl = makeActorRedirectUrl(actor.username, actor.name);

    return (
        <Container px="space16" py="space12" $withBorder={!isDetail}>
            <BoxRow>
                <ActorHeader>
                    <ActorAvatar size={40} name={actor.title} url={actor.pictureUrl} />
                    <ActorTitleWrapper>
                        <Text as="h3" weight="bold" color={theme.color.neutral.text}>{actor.title}</Text>
                        <BoxRow>
                            <Text
                                size="small"
                                weight="medium"
                                type="code"
                                color={theme.color.neutral.textSubtle}
                            >
                                {actor.username}/{actor.name}
                            </Text>
                            {actor.stats && !isDetail && <AlignBottom><StatsRow {...statsProps} /></AlignBottom>}
                        </BoxRow>
                    </ActorTitleWrapper>
                </ActorHeader>
                <AlignEnd>
                    {/* @ts-expect-error IconButton doesn't recognize `to` and `hideExternalIcon` props from Button */}
                    <IconButton Icon={ExternalLinkIcon} variant={ICON_BUTTON_VARIANTS.BORDERED} to={actorRedirectUrl} hideExternalIcon />
                </AlignEnd>
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
        </Container>
    );
};
