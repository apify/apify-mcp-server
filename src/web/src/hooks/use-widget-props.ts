import { useMcpApp } from "../context/mcp-app-context";

/**
 * Hook to access tool output (props) from the MCP server
 */
export function useWidgetProps<T extends Record<string, unknown>>(
    defaultState?: T | (() => T)
): T {
    const { toolResult } = useMcpApp();
    const props = (toolResult?.structuredContent as T) ?? null;

    const fallback =
        typeof defaultState === "function"
            ? (defaultState as () => T | null)()
            : defaultState ?? null;

    return props ?? fallback;
}
