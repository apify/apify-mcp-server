import React from "react";
import { ActorImage } from "./ActorImage";
import { Actor } from "../../types";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Badge";
import { ActorStats } from "./ActorStats";
import { ListItemFrame } from "../ui/ListItemFrame";
import { Heading } from "../ui/Heading";
import { Text } from "../ui/Text";
import { cn } from "../../utils/cn";

interface ActorCardProps {
    actor: Actor;
    isFirst?: boolean;
    isLast?: boolean;
    variant: "list" | "detail";
    subtitle: string;
    description: string;
    onViewDetails?: () => void;
    isLoading?: boolean;
    pricing?: string;
}

export const ActorCard: React.FC<ActorCardProps> = ({ actor, isFirst, isLast, variant, subtitle, onViewDetails, isLoading, description, pricing }) => {
    const title = actor.title || actor.name;
    const isDetails = variant === "detail";

    return (
        <ListItemFrame isFirst={isFirst} isLast={isLast}>
            <div className="flex gap-2 items-center w-full">
                <div className="flex flex-1 gap-3 items-center min-w-0">
                    <ActorImage pictureUrl={actor?.pictureUrl || ""} name={title} size={isDetails ? 80 : 40} />

                    <div className="flex-1 flex flex-col items-start justify-center min-w-0">
                        {isDetails ? (
                            <Heading size="2xl" weight="bold" className="mb-1">
                                {title}
                            </Heading>
                        ) : (
                            <Text truncate className="w-full">
                                {title}
                            </Text>
                        )}

                        <Text size="sm" truncate tone="secondary" className="w-full">
                            {subtitle}
                        </Text>
                    </div>
                </div>

                {!isDetails && (
                    <Button onClick={onViewDetails} disabled={isLoading} loading={isLoading} variant="primary" size="sm" className="shrink-0">
                        {isLoading ? "Loading" : "View Details"}
                    </Button>
                )}
            </div>

            {isDetails ? (
                <Text className={cn("w-full tracking-tight")}>{description}</Text>
            ) : (
                <Text size="sm" className={cn("w-full tracking-tight")}>
                    {description}
                </Text>
            )}

            <ActorStats
                totalUsers={actor.stats?.totalUsers || 0}
                totalRuns={actor.stats?.totalRuns || 0}
                successRate={actor.userActorRuns?.successRate ?? null}
            />

            {isDetails && pricing ? (
                <Badge variant="success" className="text-sm">
                    {pricing}
                </Badge>
            ) : null}
        </ListItemFrame>
    );
};
