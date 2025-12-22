import React from "react";

import { cn } from "../../utils/cn";

import { LoadingSpinner } from "./LoadingSpinner";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: "primary" | "secondary";
    size?: "sm" | "md";
    loading?: boolean;
    children: React.ReactNode;
}

const variantStyles = {
    primary: {
        backgroundColor: "var(--color-button-bg)",
        color: "var(--color-button-text)",
        border: "none",
    },
    secondary: {
        backgroundColor: "transparent",
        color: "var(--color-text-primary)",
        borderColor: "var(--color-border)",
    },
};

const sizeClasses = {
    sm: "px-3 py-1.5 text-sm",
    md: "px-4 py-2",
};

export const Button: React.FC<ButtonProps> = ({
    variant = "primary",
    size = "md",
    loading = false,
    disabled,
    children,
    className = "",
    style = {},
    ...props
}) => {
    const isDisabled = disabled || loading;

    const hoverClass = variant === "secondary" && "hover:bg-[var(--color-card-bg-alt)]";
    const opacityClass = variant === "secondary" ? "hover:opacity-80" : "hover:opacity-90";

    return (
        <button
            {...props}
            disabled={isDisabled}
            className={cn(
                "rounded-lg border disabled:opacity-50 disabled:cursor-not-allowed transition-opacity flex items-center gap-2",
                hoverClass,
                opacityClass,
                sizeClasses[size],
                className
            )}
            style={{
                ...variantStyles[variant],
                ...style,
            }}
        >
            {loading ? (
                <span className="flex items-center gap-1.5">
                    <LoadingSpinner size={size === "sm" ? "sm" : "md"} />
                    {children}
                </span>
            ) : (
                children
            )}
        </button>
    );
};

