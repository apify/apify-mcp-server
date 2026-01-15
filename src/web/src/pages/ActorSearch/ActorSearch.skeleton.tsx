import React from "react";
import { cn } from "../../utils/cn";
import { SkeletonBlock } from "../../components/ui/SkeletonBlock";
import { ListItemFrame } from "../../components/ui/ListItemFrame";
import { Card } from "../../components/ui/Card";
import { Heading } from "../../components/ui/Heading";
import { Text } from "../../components/ui/Text";

interface ActorListItemSkeletonProps {
    isFirst?: boolean;
    isLast?: boolean;
}

const ActorListItemSkeleton: React.FC<ActorListItemSkeletonProps> = ({ isFirst, isLast }) => {
    return (
        <ListItemFrame isFirst={isFirst} isLast={isLast} className={cn("gap-3")}>
            <div className="flex gap-2 items-center w-full">
                <div className="flex flex-1 gap-3 items-center min-w-0">
                    <SkeletonBlock className="w-11 h-11 rounded-lg shrink-0" />

                    <div className="flex-1 flex flex-col gap-2 min-w-0">
                        <SkeletonBlock className="h-4 w-3/5" />
                        <SkeletonBlock className="h-3 w-2/5" />
                    </div>
                </div>

                <SkeletonBlock className="w-[100px] h-8 rounded-lg" />
            </div>

            <div className="w-full space-y-2">
                <SkeletonBlock className="h-3 w-full" />
                <SkeletonBlock className="h-3 w-4/5" />
            </div>

            <div className="flex items-center gap-4">
                <SkeletonBlock className="h-3 w-[60px]" />
                <SkeletonBlock className="h-3 w-[60px]" />
                <SkeletonBlock className="h-3 w-[60px]" />
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
        <div className="flex flex-col gap-4 w-full">
            <Card variant="default" padding="lg" rounded="3xl" className="w-full">
                <div className="flex flex-col gap-3">
                    <div className="flex items-center gap-3">
                        <SkeletonBlock className="w-16 h-16 rounded-xl" />
                        <div className="flex-1 flex flex-col gap-2 min-w-0">
                            <SkeletonBlock className="h-5 w-1/2" />
                            <SkeletonBlock className="h-4 w-1/3" />
                            <SkeletonBlock className="h-3 w-2/3" />
                        </div>
                    </div>
                    <SkeletonBlock className="h-4 w-1/4" />
                </div>
            </Card>

            <SectionSkeleton title="Documentation" paragraphs={5} />
            <SectionSkeleton title="Input Parameters" paragraphs={3} />
            <SectionSkeleton title="Technical Details" paragraphs={4} />
        </div>
    );
};

const SectionSkeleton: React.FC<{ title: string; paragraphs?: number }> = ({ title, paragraphs = 3 }) => {
    return (
        <Card variant="default" padding="lg" rounded="3xl" className="w-full">
            <Heading as="h3" weight="bold" className="mb-4">
                {title}
            </Heading>
            <div className="space-y-2">
                {Array.from({ length: paragraphs }).map((_, i) => (
                    <SkeletonBlock key={i} className="h-3 w-full" />
                ))}
            </div>
            {title === "Documentation" && (
                <Text as="p" size="sm" tone="secondary" className="italic mt-2" />
            )}
        </Card>
    );
};

