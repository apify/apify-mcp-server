import React from "react";
import { MembersFilled, Play, Check } from "../ui/Icons";
import { formatNumber } from "../../utils/formatting";
import { cn } from "../../utils/cn";
import { Text } from "../ui/Text";

type ActorStatsProps = {
    totalUsers: number;
    totalRuns: number;
    successRate: number | null;
    className?: string;
};

export const ActorStats: React.FC<ActorStatsProps> = ({ totalUsers, totalRuns, successRate, className }) => {
    const iconSize = "w-[18px] h-[20px]";

    return (
        <Text as="div" size="xs" tone="secondary" className={cn("flex items-center gap-4", className)}>
            <Stat icon={<MembersFilled className={iconSize} />} text={`${formatNumber(totalUsers)} users`} />
            <Stat icon={<Play className={iconSize} />} text={`${formatNumber(totalRuns)} runs`} />

            {successRate !== null && (
                <div className="flex items-center gap-1">
                    <Check className={iconSize} />
                    <span>{successRate}% success</span>
                </div>
            )}
        </Text>
    );
};

const Stat: React.FC<{ icon: React.ReactNode; text: string }> = ({ icon, text }) => {
    return (
        <div className="flex items-center gap-1">
            {icon}
            <span>{text}</span>
        </div>
    );
};
