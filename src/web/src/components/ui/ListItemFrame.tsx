import React from "react";
import { cn } from "../../utils/cn";

type ListItemFrameProps = {
    children: React.ReactNode;
    isFirst?: boolean;
    isLast?: boolean;
    className?: string;
};

export const ListItemFrame: React.FC<ListItemFrameProps> = ({ children, isFirst, isLast, className }) => {
    return (
        <div
            className={cn(
                "flex flex-col gap-4 items-start justify-center px-4 w-full",
                isFirst ? "pt-4" : "pt-3",
                isLast ? "pb-4" : "pb-3",
                !isLast && "border-b border-[var(--color-border)]",
                className
            )}
        >
            {children}
        </div>
    );
};
