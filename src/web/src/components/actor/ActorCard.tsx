import React from "react";
import styled from "styled-components";

import { Actor } from "../../types";
import { Text, Box, StoreActorHeader, IconButton, ICON_BUTTON_VARIANTS, theme, Container } from "@apify/ui-library";
import { PeopleIcon, CoinIcon, StarEmptyIcon, FullscreenIcon
 } from "@apify/ui-icons";
import { formatNumber, getPricingInfo, formatDecimalNumber } from "../../utils/formatting";
import { ActorStats, PricingInfo } from "../../types";

interface ActorCardProps {
    actor: Actor;
    isFirst?: boolean;
    isLast?: boolean;
    description: string;
    onViewDetails?: () => void;
    isLoading?: boolean;
}

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
    align-items: flex-start;
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

const PreWrapText = styled.span`
    white-space: pre-wrap;
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
    stats: ActorStats
    pricingInfo?: PricingInfo
    rating?: {
        average: number;
        count: number;
    }
}

const StatsRow: React.FC<StatsRowProps> = ({ stats, pricingInfo, rating }) => {
    const {totalUsers} = stats || {}
    const {value: pricingValue, additionalInfo: pricingAdditionalInfo} = getPricingInfo(pricingInfo || {pricingModel: "FREE", monthlyChargeUsd: 0, pricePerResultUsd: 0});

    return (
        <BoxRow py="space2">
            <StyledSeparator />
            <Stat
                icon={<PeopleIcon size="12" color={theme.color.neutral.icon} />}
                value={formatNumber(totalUsers)}
            />
            {rating && <>
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

export const ActorCard: React.FC<ActorCardProps> = ({ actor, onViewDetails }) => {
    return (
        <Container px="space16" py="space12">
            <BoxRow>
                <StoreActorHeader
                    name={actor.name}
                    title={actor.title}
                    pictureUrl={actor.pictureUrl}
                    username={actor.username}
                />
                {actor.stats && <AlignBottom><StatsRow stats={actor.stats} pricingInfo={actor.currentPricingInfo} rating={actor.rating} /></AlignBottom>}
                <AlignEnd><IconButton Icon={FullscreenIcon} variant={ICON_BUTTON_VARIANTS.BORDERED} onClick={onViewDetails} /></AlignEnd>
            </BoxRow>

            <Text
                size="regular"
                weight="normal"
                color={theme.color.neutral.text}
                as={PreWrapText}
            >
                {actor.description}
            </Text>
        </Container>
    );
};
