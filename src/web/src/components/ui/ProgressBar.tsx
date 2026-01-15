import React from "react";

import { cn } from "../../utils/cn";

interface ProgressBarProps {
    variant?: "warning" | "success" | "error";
    className?: string;
}

const variantColors = {
    warning: "var(--color-warning)",
    success: "var(--color-success)",
    error: "var(--color-error)",
};

export const ProgressBar: React.FC<ProgressBarProps> = ({ variant = "warning", className = "" }) => {
    return (
        <div className={cn("w-full", className)}>
            <div className="h-1 rounded-full overflow-hidden" style={{ backgroundColor: "var(--color-border)" }}>
                <div
                    className="h-full rounded-full animate-pulse"
                    style={{
                        backgroundColor: variantColors[variant],
                        width: "100%",
                        animation: "pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite",
                    }}
                />
            </div>
        </div>
    );
};

