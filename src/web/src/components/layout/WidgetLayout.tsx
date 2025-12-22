import React from "react";
import { useMaxHeight } from "../../hooks/use-max-height";
import { cn } from "../../utils/cn";

interface WidgetLayoutProps {
    children: React.ReactNode;
    className?: string;
    style?: React.CSSProperties;
}

export const WidgetLayout: React.FC<WidgetLayoutProps> = ({ children, className = "", style = {} }) => {
    const maxHeight = useMaxHeight();

    return (
        <div
            className={cn("flex flex-col gap-6 items-start pb-10 pt-4 px-5 w-full overflow-y-auto", className)}
            style={{
                fontFamily: "SF Pro, -apple-system, BlinkMacSystemFont, sans-serif",
                maxHeight: maxHeight ? `${maxHeight}px` : undefined,
                ...style,
            }}
        >
            {children}
        </div>
    );
};
