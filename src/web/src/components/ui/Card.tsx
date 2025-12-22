import React from "react";

import { cn } from "../../utils/cn";

type CardVariant = "default" | "alt" | "code";
type CardPadding = "none" | "sm" | "md" | "lg";
type CardRounded = "none" | "lg" | "2xl" | "3xl";
type CardShadow = "none" | "sm" | "md";

const variantClass: Record<CardVariant, string> = {
    default: "bg-[var(--color-card-bg)]",
    alt: "bg-[var(--color-card-bg-alt)]",
    code: "bg-[var(--color-code-bg)]",
};

const paddingClass: Record<CardPadding, string | undefined> = {
    none: undefined,
    sm: "p-4",
    md: "p-5",
    lg: "p-6",
};

const roundedClass: Record<CardRounded, string | undefined> = {
    none: undefined,
    lg: "rounded-lg",
    "2xl": "rounded-2xl",
    "3xl": "rounded-3xl",
};


const shadowClass: Record<CardShadow, string | undefined> = {
    none: undefined,
    sm: "shadow-[0_1px_2px_rgba(0,0,0,0.06),0_4px_12px_rgba(0,0,0,0.04)]",
    md: "shadow-[0_1px_3px_rgba(0,0,0,0.08),0_8px_24px_rgba(0,0,0,0.06)]",
};

type CardProps = React.HTMLAttributes<HTMLElement> & {
    as?: React.ElementType;
    variant?: CardVariant;
    padding?: CardPadding;
    rounded?: CardRounded;
    shadow?: CardShadow;
};

export function Card({
    as: Component = "div",
    variant = "default",
    padding = "none",
    rounded = "2xl",
    shadow = "sm",
    className,
    ...props
}: CardProps) {
    return <Component className={cn(variantClass[variant], paddingClass[padding], roundedClass[rounded], shadowClass[shadow], className)} {...props} />;
}

