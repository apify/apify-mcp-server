import React from "react";
import { cn } from "../../utils/cn";

type HeadingSize = "2xl" | "xl" | "lg" | "md" | "sm";
type Weight = "normal" | "medium" | "semibold" | "bold";
type Tone = "primary" | "secondary" | "tertiary" | "inherit";

const sizeClass: Record<HeadingSize, string> = {
    "2xl": "text-2xl leading-8",
    xl: "text-xl leading-7",
    lg: "text-lg leading-6",
    md: "text-base leading-6",
    sm: "text-sm leading-5",
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

interface HeadingProps extends React.HTMLAttributes<HTMLElement> {
    as?: React.ElementType;
    size?: HeadingSize;
    weight?: Weight;
    tone?: Tone;
}

export function Heading({ as: Component = "h2", size = "lg", weight = "semibold", tone = "primary", className, ...props }: HeadingProps) {
    return <Component className={cn(sizeClass[size], weightClass[weight], toneClass[tone], className)} {...props} />;
}
