import { useState } from "react";

/**
 * Hook to manage widget state.
 * No MCP Apps equivalent for widget state persistence yet — uses plain React state.
 */
export function useWidgetState<T extends Record<string, unknown>>(
    defaultState: T | (() => T)
): [T, (state: T) => Promise<void>] {
    const initialState =
        typeof defaultState === "function"
            ? (defaultState as () => T)()
            : defaultState;

    const [state, setState] = useState<T>(initialState);

    return [state, async (newState: T) => setState(newState)];
}
