import React from "react";

import { cn } from "../../utils/cn";

interface BadgeProps {
    variant?: "success" | "danger" | "warning" | "secondary";
    children: React.ReactNode;
    className?: string;
}

export const Badge: React.FC<BadgeProps> = ({ variant = "secondary", children, className = "" }) => {
    const getVariantStyles = (): React.CSSProperties => {
        switch (variant) {
            case "success":
                return {
                    backgroundColor: "var(--color-success-soft)",
                    color: "var(--color-success)",
                };
            case "danger":
                return {
                    backgroundColor: "var(--color-error-soft)",
                    color: "var(--color-error)",
                };
            case "warning":
                return {
                    backgroundColor: "var(--color-warning-soft)",
                    color: "var(--color-warning)",
                };
            default: // secondary
                return {
                    backgroundColor: "var(--color-secondary-soft)",
                    color: "var(--color-text-primary)",
                };
        }
    };

    return (
        <span
            className={cn("px-2 py-1 rounded text-xs font-medium", className)}
            style={getVariantStyles()}
        >
            {children}
        </span>
    );
};

