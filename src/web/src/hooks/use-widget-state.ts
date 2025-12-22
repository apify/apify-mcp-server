import { useEffect, useState } from "react";

/**
 * Hook to manage widget state with persistence
 * Based on https://developers.openai.com/apps-sdk/build/custom-ux#persist-component-state-expose-context-to-chatgpt
 */
export function useWidgetState<T extends Record<string, unknown>>(
  defaultState: T | (() => T)
): [T, (state: T) => Promise<void>] {
  const initialState =
    typeof defaultState === "function"
      ? (defaultState as () => T)()
      : defaultState;

  const [state, setState] = useState<T>(initialState);

  // Restore cached state on mount
  useEffect(() => {
    if (window.openai?.widgetState) {
      setState(window.openai.widgetState as T);
    }
  }, []);

  // Persist state changes
  const setWidgetState = async (newState: T) => {
    setState(newState);
    if (window.openai?.setWidgetState) {
      await window.openai.setWidgetState(newState);
    }
  };

  return [state, setWidgetState];
}