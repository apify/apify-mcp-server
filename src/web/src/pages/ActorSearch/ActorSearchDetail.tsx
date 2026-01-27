import React, { useMemo } from "react";
import { ArrowLeft } from "../../components/ui/Icons";
import { formatPricing } from "../../utils/formatting";
import { ActorDetails } from "../../types";
import { Button } from "../../components/ui/Button";
import { ActorCard } from "../../components/actor/ActorCard";
import { Heading } from "../../components/ui/Heading";
import { Card } from "../../components/ui/Card";
import { Markdown } from "../../components/ui/Markdown";

interface ActorSearchDetailProps {
    details: ActorDetails;
    onBackToList: () => void;
    showBackButton?: boolean;
}

export const ActorSearchDetail: React.FC<ActorSearchDetailProps> = ({ details, onBackToList, showBackButton = true }) => {
    const actor = details.actorInfo;

    const pricingText = useMemo(() => {
        return formatPricing(
            actor.currentPricingInfo || {
                pricingModel: "FREE",
                pricePerResultUsd: 0,
                monthlyChargeUsd: 0,
            }
        );
    }, [actor.currentPricingInfo]);

    return (
        <div className="flex flex-col gap-4 w-full">
            {showBackButton && (
                <Button onClick={onBackToList} variant="secondary" size="md" className="self-start">
                    <ArrowLeft />
                    <span>Back to search results</span>
                </Button>
            )}

            <SectionCard>
                <ActorCard
                    actor={actor}
                    variant="detail"
                    subtitle={`${actor.username}/${actor.name}`}
                    isLast={true}
                    description={actor.description}
                    pricing={pricingText}
                />
            </SectionCard>

            {details.actorCard && <TechnicalDetailsSection actorCard={details.actorCard} />}
        </div>
    );
};

const SectionCard: React.FC<{ title?: string; children: React.ReactNode }> = ({ title, children }) => {
    return (
        <Card variant="default" padding="lg" rounded="3xl" className="w-full" shadow="md">
            {title ? (
                <Heading as="h3" weight="bold" className="mb-4">
                    {title}
                </Heading>
            ) : null}
            {children}
        </Card>
    );
};

const TechnicalDetailsSection: React.FC<{ actorCard: string }> = ({ actorCard }) => {
    return (
        <SectionCard title="Technical Details">
            <div className="rounded-lg overflow-x-auto p-5 bg-[var(--color-code-bg)] text-[var(--color-code-text)]">
                <Markdown>{actorCard.replace(/\t/g, "    ").trim()}</Markdown>
            </div>
        </SectionCard>
    );
};
