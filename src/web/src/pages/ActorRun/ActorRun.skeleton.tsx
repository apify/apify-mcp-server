import React from "react";
import { SkeletonBlock } from "../../components/ui/SkeletonBlock";
import { Card } from "../../components/ui/Card";

export const ActorRunSkeleton: React.FC = () => {
    return (
        <Card variant="alt" padding="lg" className="w-full">
            <SkeletonBlock className="h-8 w-3/4 mb-4" />
            <SkeletonBlock className="h-4 w-1/2 mb-2" />
            <SkeletonBlock className="h-4 w-2/3" />
        </Card>
    );
};
