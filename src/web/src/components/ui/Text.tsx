import React from "react";
import { cn } from "../../utils/cn";

type TextSize = "xs" | "sm" | "md" | "lg";
type Weight = "normal" | "medium" | "semibold" | "bold";
type Tone = "primary" | "secondary" | "tertiary" | "inherit";

const sizeClass: Record<TextSize, string> = {
    xs: "text-xs leading-4",
    sm: "text-sm leading-5",
    md: "text-base leading-6",
    lg: "text-lg leading-7",
};

const weightClass: Record<Weight, string> = {
    normal: "font-normal",
    medium: "font-medium",
    semibold: "font-semibold",
    bold: "font-bold",
};

const toneClass: Record<Tone, string | undefined> = {
    primary: "text-[var(--color-text-primary)]",
    secondary: "text-[var(--color-text-secondary)]",
    tertiary: "text-[var(--color-text-tertiary)]",
    inherit: undefined,
};

interface TextProps extends React.HTMLAttributes<HTMLElement> {
    as?: React.ElementType;
    size?: TextSize;
    weight?: Weight;
    tone?: Tone;
    truncate?: boolean;
}

export function Text({ as: Component = "p", size = "md", weight = "normal", tone = "primary", truncate = false, className, ...props }: TextProps) {
    return <Component className={cn(sizeClass[size], weightClass[weight], toneClass[tone], truncate && "truncate", className)} {...props} />;
}
