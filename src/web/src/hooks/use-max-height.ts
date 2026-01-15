import { useOpenAiGlobal } from "../hooks/use-open-ai-global";

export const useMaxHeight = (): number | null => {
  return useOpenAiGlobal("maxHeight");
};