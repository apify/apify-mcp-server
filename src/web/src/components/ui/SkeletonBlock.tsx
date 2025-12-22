import React from "react";
import { cn } from "../../utils/cn";

interface SkeletonBlockProps {
  className?: string;
  style?: React.CSSProperties;
}

export const SkeletonBlock: React.FC<SkeletonBlockProps> = ({ className, style }) => {
  return (
    <div
      className={cn("animate-pulse rounded", className)}
      style={{
        backgroundColor: "var(--color-code-bg)",
        ...style,
      }}
    />
  );
};
