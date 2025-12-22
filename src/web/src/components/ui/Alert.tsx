import React from "react";

import { cn } from "../../utils/cn";

import { Heading } from "./Heading";
import { Text } from "./Text";

interface AlertProps {
    variant?: "success" | "error" | "warning";
    title?: string;
    children: React.ReactNode;
    className?: string;
}

const variantStyles = {
    success: {
        backgroundColor: "var(--color-success-bg)",
        borderColor: "var(--color-success-border)",
        titleColor: "var(--color-success)",
    },
    error: {
        backgroundColor: "var(--color-error-bg)",
        borderColor: "var(--color-error-border)",
        titleColor: "var(--color-error)",
    },
    warning: {
        backgroundColor: "var(--color-warning-soft)",
        borderColor: "var(--color-warning)",
        titleColor: "var(--color-warning)",
    },
};

export const Alert: React.FC<AlertProps> = ({ variant = "error", title, children, className = "" }) => {
    const styles = variantStyles[variant];

    return (
        <div
            className={cn("rounded-xl p-4", className)}
            style={{
                backgroundColor: styles.backgroundColor,
                border: `1px solid ${styles.borderColor}`,
            }}
        >
            {title && (
                <Heading as="h3" size="md" className="mb-1" tone="inherit" style={{ color: styles.titleColor }}>
                    {title}
                </Heading>
            )}
            <Text as="div" size="sm">
                {children}
            </Text>
        </div>
    );
};

