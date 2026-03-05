import { useMcpApp } from "../context/mcp-app-context";
import type { DisplayMode } from "../types";

export const useDisplayMode = (): DisplayMode | null => {
    const { hostContext } = useMcpApp();
    return (hostContext?.displayMode as DisplayMode) ?? null;
};
