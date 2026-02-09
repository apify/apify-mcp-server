import React from "react";
import styled, { keyframes } from "styled-components";
import { theme } from "@apify/ui-library";

interface SkeletonBlockProps {
  style?: React.CSSProperties;
}

const pulse = keyframes`
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
`;

const StyledSkeletonBlock = styled.div`
  background-color: ${theme.color.neutral.backgroundSubtle};
  border-radius: ${theme.radius.radius4};
  animation: ${pulse} 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
`;

export const SkeletonBlock: React.FC<SkeletonBlockProps> = ({ style }) => {
  return <StyledSkeletonBlock style={style} />;
};
