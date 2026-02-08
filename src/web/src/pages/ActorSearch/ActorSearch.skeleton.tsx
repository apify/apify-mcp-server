import React from "react";
import { SkeletonBlock } from "../../components/ui/SkeletonBlock";
import { ListItemFrame } from "../../components/ui/ListItemFrame";
import { Card } from "../../components/ui/Card";

interface ActorListItemSkeletonProps {
    isFirst?: boolean;
    isLast?: boolean;
}

const ActorListItemSkeleton: React.FC<ActorListItemSkeletonProps> = ({ isFirst, isLast }) => {
    return (
        <ListItemFrame isFirst={isFirst} isLast={isLast}>
            <div className="flex gap-3 items-start w-full">
                {/* Larger actor logo placeholder (64px) */}
                <SkeletonBlock className="w-16 h-16 rounded-lg shrink-0" />

                {/* Content Column */}
                <div className="flex-1 flex flex-col gap-1 min-w-0">
                    {/* Title Row with Expand Button */}
                    <div className="flex items-start justify-between gap-2">
                        <SkeletonBlock className="h-5 w-2/3" />
                        {/* Icon button placeholder */}
                        <SkeletonBlock className="w-8 h-8 rounded-lg shrink-0" />
                    </div>

                    {/* Inline Stats placeholder */}
                    <SkeletonBlock className="h-4 w-4/5 mt-1" />

                    {/* Description (3 lines) */}
                    <div className="w-full space-y-1 mt-1">
                        <SkeletonBlock className="h-3 w-full" />
                        <SkeletonBlock className="h-3 w-full" />
                        <SkeletonBlock className="h-3 w-3/4" />
                    </div>
                </div>
            </div>
        </ListItemFrame>
    );
};

export const ActorSearchResultsSkeleton: React.FC<{ items?: number }> = ({ items = 3 }) => {
    return (
        <Card variant="alt" padding="none" className="w-full overflow-hidden">
            <div className="flex flex-col w-full">
                {Array.from({ length: items }).map((_, i) => (
                    <ActorListItemSkeleton key={i} isFirst={i === 0} isLast={i === items - 1} />
                ))}
            </div>
        </Card>
    );
};

export const ActorSearchDetailSkeleton: React.FC = () => {
    return (
        <div className="flex flex-col w-full min-h-full" style={{ background: 'var(--color-card-bg-alt)', padding: '16px' }}>
            {/* Centered Card Wrapper */}
            <div className="w-full max-w-[800px] mx-auto">
                <Card variant="default" padding="lg" rounded="lg" className="w-full">
                    {/* Header Section */}
                    <div className="flex flex-col gap-3 mb-4">
                        <div className="flex items-center gap-3">
                            {/* Smaller actor icon (32-40px) */}
                            <SkeletonBlock className="w-10 h-10 rounded-lg" />
                            <div className="flex-1 flex flex-col gap-2 min-w-0">
                                <SkeletonBlock className="h-5 w-1/2" />
                                <SkeletonBlock className="h-4 w-1/3" />
                            </div>
                        </div>
                        {/* Description */}
                        <div className="space-y-2">
                            <SkeletonBlock className="h-3 w-full" />
                            <SkeletonBlock className="h-3 w-4/5" />
                        </div>
                        {/* Stats row */}
                        <SkeletonBlock className="h-4 w-2/3" />
                    </div>

                    {/* Expandable Sections */}
                    <div className="flex flex-col gap-2">
                        <SectionHeaderSkeleton />
                        <SectionHeaderSkeleton />
                        <SectionHeaderSkeleton />
                        <SectionHeaderSkeleton />
                        <SectionHeaderSkeleton />
                    </div>
                </Card>
            </div>
        </div>
    );
};

const SectionHeaderSkeleton: React.FC = () => {
    return (
        <div className="flex items-center justify-between p-3 bg-[var(--color-card-bg-alt)] rounded-lg">
            <SkeletonBlock className="h-5 w-24" />
            <SkeletonBlock className="h-4 w-16" />
        </div>
    );
};

