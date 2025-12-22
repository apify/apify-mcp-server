import { useOpenAiGlobal } from "../hooks/use-open-ai-global";
import type { DisplayMode } from "../types";

export const useDisplayMode = (): DisplayMode | null => {
  return useOpenAiGlobal("displayMode");
};