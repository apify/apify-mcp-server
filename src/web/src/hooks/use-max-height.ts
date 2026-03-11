import { useMcpApp } from "../context/mcp-app-context";

export const useMaxHeight = (): number | null => {
    const { hostContext } = useMcpApp();
    const dims = hostContext?.containerDimensions;
    if (dims && "maxHeight" in dims) return dims.maxHeight ?? null;
    if (dims && "height" in dims) return dims.height;
    return null;
};
